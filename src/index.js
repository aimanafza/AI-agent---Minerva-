import { config } from "./config.js";
import * as slack from "./slack.js";
import { triage, enforceGuardrails, reviseDecision } from "./orchestrator.js";
import { execute } from "./executor.js";
import { sweep, healthReport } from "./watcher.js";
import { sprintProposal, revisePlan } from "./sprint.js";

// Live sprint-planning conversation: !sprint opens it, replies revise the
// plan, ✅ (or an approve reply) locks it.
let sprintSession = null; // { threadTs, planTs, plan, lastReplyTs }

import { loadState, saveState } from "./state.js";
import { onItMessage, followUpQuestionMessage, proposalMessage, rejectedMessage, triageFailedMessage, linearTicketDetectedMessage, sprintDraftingMessage, sprintLockedMessage, revisedProposalMessage } from "./voice.js";

// Pending state survives restarts (.state.json) — a restart must not orphan
// open proposal threads.
const persisted = loadState();
// Threads where we asked the reporter a follow-up and are waiting for an answer.
const pendingQuestions = new Set(persisted.pendingQuestions);
// Threads where a triage proposal awaits approval: thread_ts -> {decision, notes, proposalTs}
const pendingApprovals = new Map(Object.entries(persisted.pendingApprovals));
const persist = () => saveState({ pendingApprovals, pendingQuestions });

// Anyone on the team can approve — by reply OR by reacting to the proposal.
const APPROVE_TEXT = /^\s*(approve[d]?|yes+|yep|yeah|lgtm|ok(ay)?|ship( it)?|go( ahead)?|file( it)?|✅|👍)\b/i;
const REJECT_TEXT = /^\s*(reject(ed)?|no|nope|deny|denied|drop(ped)?|don'?t|❌|👎)\b/i;
const APPROVE_REACTIONS = new Set(["white_check_mark", "heavy_check_mark", "ballot_box_with_check", "+1", "thumbsup", "ok_hand", "raised_hands"]);
const REJECT_REACTIONS = new Set(["x", "-1", "thumbsdown", "no_entry", "no_entry_sign"]);

// PM routing (optional, via PM_MAP): route each proposal to the PM who owns
// the bug's area, and only PMs can approve/reject/edit. Without PM_MAP,
// anyone can (small-team mode).
const pmIds = config.pmMap ? new Set(Object.values(config.pmMap).flat()) : null;
const isPM = (userId) => !pmIds || pmIds.has(userId);

function pmMention(decision) {
  if (!config.pmMap) return "";
  const byLabel = (decision.labels || [])
    .map((l) => config.pmMap[l.toLowerCase()])
    .find(Boolean);
  const ids = byLabel ? [byLabel] : [].concat(config.pmMap.default || []);
  return ids.length ? ids.map((id) => `<@${id}>`).join(" ") + " your call on this one\n" : "";
}

function reactionVerdict(reactions) {
  for (const r of reactions) {
    const fromPM = !pmIds || r.users.some((u) => pmIds.has(u));
    if (!fromPM) continue;
    if (APPROVE_REACTIONS.has(r.name)) return "approve";
    if (REJECT_REACTIONS.has(r.name)) return "reject";
  }
  return null;
}

async function handleReport(msg, botUserId) {
  const thread_ts = msg.thread_ts || msg.ts;
  console.log(`\n--- New report: ${msg.text.slice(0, 80)}`);
  await slack.postMessage(onItMessage(msg.user), thread_ts);

  // If this is a reply in a thread we asked a question in, feed the whole thread back.
  let threadContext = [];
  if (msg.thread_ts && pendingQuestions.has(msg.thread_ts)) {
    const replies = await slack.fetchThread(msg.thread_ts);
    threadContext = replies.map((m) => `${m.user === botUserId ? "agent" : "reporter"}: ${m.text}`);
    pendingQuestions.delete(msg.thread_ts);
    persist();
  }

  const result = await triage(msg.text, threadContext);

  if (result.kind === "question") {
    pendingQuestions.add(thread_ts);
    persist();
    await slack.postMessage(followUpQuestionMessage(result.question), thread_ts);
    console.log(`Asked follow-up: ${result.question}`);
    return;
  }

  const { decision, notes } = await enforceGuardrails(result.decision, result.trace, msg.text);

  if (config.requireApproval) {
    const posted = await slack.postMessage(pmMention(decision) + proposalMessage(decision, notes), thread_ts);
    pendingApprovals.set(thread_ts, { decision, notes, proposalTs: posted.ts });
    persist();
    console.log(`Proposal posted, awaiting approval: ${decision.title}`);
    return;
  }

  const issue = await execute(decision, { thread_ts, guardrailNotes: notes });
  console.log(`Filed ${issue.identifier} (${decision.severity}) -> ${decision.assignee_github || "triage queue"}`);
}

// Entry point 2: a ticket created directly in Linear (no assignee, no
// priority). Same brain, same approval gate — but approval UPDATES the
// existing ticket and moves it to Backlog instead of creating a new one.
async function handleLinearTicket(issue) {
  console.log(`\n--- Untriaged Linear ticket: ${issue.identifier} — ${issue.title}`);
  const root = await slack.postMessage(
    linearTicketDetectedMessage(issue.identifier, issue.title)
  );
  const thread_ts = root.ts;
  const report =
    `Ticket created directly in Linear, currently untriaged (no assignee, no priority):\n` +
    `${issue.identifier}: ${issue.title}\n${issue.description || "(no description)"}\n\n` +
    `NOTE: ${issue.identifier} is this very ticket — never propose it as its own duplicate.`;

  const result = await triage(report);
  if (result.kind === "question") {
    pendingQuestions.add(thread_ts);
    persist();
    await slack.postMessage(followUpQuestionMessage(`${result.question} (for ${issue.identifier})`), thread_ts);
    return;
  }
  const { decision, notes } = await enforceGuardrails(result.decision, result.trace, report);
  const posted = await slack.postMessage(pmMention(decision) + proposalMessage(decision, notes), thread_ts);
  pendingApprovals.set(thread_ts, {
    decision,
    notes,
    proposalTs: posted.ts,
    updateIssue: { id: issue.id, identifier: issue.identifier },
  });
  persist();
  console.log(`Proposal posted for ${issue.identifier}, awaiting approval`);
}

async function main() {
  const botUserId = await slack.getBotUserId();
  let lastTs = String(Date.now() / 1000); // only react to messages after startup
  console.log(`triage-agent watching Slack channel ${config.slackChannel} (bot ${botUserId})`);

  // Watcher: escalations + component health + untriaged-in-Linear detection
  setInterval(() => {
    sweep()
      .then(async (untriaged) => {
        for (const t of untriaged || []) {
          await handleLinearTicket(t).catch((e) => console.error("linear-triage:", e.message));
        }
      })
      .catch((e) => console.error("watcher:", e.message));
  }, config.watchIntervalSec * 1000);

  // Ingest: poll the channel
  for (;;) {
    try {
      const messages = await slack.fetchNewMessages(lastTs);
      for (const msg of messages) {
        if (msg.ts > lastTs) lastTs = msg.ts;
        if (msg.user === botUserId || msg.bot_id) continue; // ignore ourselves
        if (msg.subtype) continue; // joins, edits, etc.
        if (msg.text?.trim().toLowerCase() === "!health") {
          await healthReport().catch((e) => console.error("health:", e.message));
          continue;
        }
        if (msg.text?.trim().toLowerCase() === "!sprint") {
          await slack.postMessage(sprintDraftingMessage());
          try {
            const plan = await sprintProposal();
            const posted = await slack.postMessage(plan);
            sprintSession = { threadTs: posted.ts, planTs: posted.ts, plan, lastReplyTs: null };
            console.log("Sprint session opened — replies in the thread revise the plan");
          } catch (e) {
            console.error("sprint:", e.message);
          }
          continue;
        }
        await handleReport(msg, botUserId).catch(async (e) => {
          console.error("triage failed:", e);
          await slack.postMessage(triageFailedMessage(e.message), msg.thread_ts || msg.ts);
        });
      }
      // Poll threads awaiting approval. A PM's reply (approve/reject/anything
      // else = edit request) or reaction on the proposal decides; without
      // PM_MAP any human counts. Non-verdict PM replies revise the proposal.
      for (const [t, pending] of [...pendingApprovals]) {
        let verdict = null;
        let editRequest = null;

        const replies = await slack.fetchThread(t);
        const last = replies[replies.length - 1];
        if (last && last.user !== botUserId && !last.bot_id && isPM(last.user)) {
          const text = (last.text || "").trim();
          if (APPROVE_TEXT.test(text)) verdict = "approve";
          else if (REJECT_TEXT.test(text)) verdict = "reject";
          else if (text && last.ts !== pending.lastReplyTs) editRequest = { text, ts: last.ts, replies };
        }

        if (!verdict && pending.proposalTs) {
          try {
            const reactions = await slack.getReactions(pending.proposalTs);
            verdict = reactionVerdict(reactions) || verdict;
          } catch (e) {
            // reactions:read scope not granted yet — reply-based approval still works
            if (!String(e.message).includes("missing_scope")) console.error("reactions:", e.message);
          }
        }

        if (!verdict && editRequest) {
          pending.lastReplyTs = editRequest.ts;
          persist();
          const transcript = editRequest.replies
            .map((m) => `${m.user === botUserId ? "mamdani" : "pm"}: ${m.text}`)
            .join("\n");
          try {
            const revised = await reviseDecision(pending.decision, transcript);
            const posted = await slack.postMessage(revisedProposalMessage(revised, pending.notes), t);
            pending.decision = revised;
            pending.proposalTs = posted.ts;
            persist();
            console.log(`Proposal revised from PM feedback: ${revised.title}`);
          } catch (e) {
            console.error("revise:", e.message);
          }
          continue;
        }

        if (verdict === "approve") {
          pendingApprovals.delete(t);
          persist();
          const issue = await execute(pending.decision, {
            thread_ts: t,
            guardrailNotes: pending.notes,
            updateIssue: pending.updateIssue,
          });
          console.log(`Approved and ${pending.updateIssue ? "updated" : "filed"} ${issue.identifier}`);
        } else if (verdict === "reject") {
          pendingApprovals.delete(t);
          persist();
          await slack.postMessage(rejectedMessage(), t);
          console.log(`Rejected: ${pending.decision.title}`);
        }
        // anything else in the thread: keep waiting
      }

      // Live sprint-planning session: replies revise the plan, ✅/approve locks it.
      if (sprintSession) {
        try {
          const replies = await slack.fetchThread(sprintSession.threadTs);
          const last = replies[replies.length - 1];
          let lock = false;
          try {
            const reactions = await slack.getReactions(sprintSession.planTs);
            if (reactionVerdict(reactions) === "approve") lock = true;
          } catch {
            // reactions scope missing — reply-based lock still works
          }
          if (!lock && last && last.user !== botUserId && !last.bot_id && last.ts !== sprintSession.lastReplyTs) {
            if (APPROVE_TEXT.test((last.text || "").trim())) {
              lock = true;
            } else {
              sprintSession.lastReplyTs = last.ts;
              const transcript = replies
                .filter((m) => m.ts !== sprintSession.threadTs)
                .map((m) => `${m.user === botUserId ? "mamdani" : "pm"}: ${m.text}`)
                .join("\n");
              const revised = await revisePlan(sprintSession.plan, transcript);
              const postedRev = await slack.postMessage(revised, sprintSession.threadTs);
              sprintSession.plan = revised;
              sprintSession.planTs = postedRev.ts;
              console.log("Sprint plan revised from thread feedback");
            }
          }
          if (lock) {
            await slack.postMessage(sprintLockedMessage(), sprintSession.threadTs);
            sprintSession = null;
            console.log("Sprint session locked");
          }
        } catch (e) {
          console.error("sprint-session:", e.message);
        }
      }

      // Also poll threads awaiting reporter answers
      for (const t of [...pendingQuestions]) {
        const replies = await slack.fetchThread(t);
        const last = replies[replies.length - 1];
        if (last && last.user !== botUserId && !last.bot_id) {
          await handleReport({ ...last, thread_ts: t }, botUserId).catch((e) =>
            console.error("follow-up triage failed:", e.message)
          );
        }
      }
    } catch (e) {
      console.error("poll error:", e.message);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main();
