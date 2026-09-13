import { config } from "./config.js";
import * as slack from "./slack.js";
import { triage, enforceGuardrails } from "./orchestrator.js";
import { execute } from "./executor.js";
import { sweep, healthReport } from "./watcher.js";

import { loadState, saveState } from "./state.js";
import { onItMessage, followUpQuestionMessage, proposalMessage, rejectedMessage, triageFailedMessage } from "./voice.js";

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

async function handleReport(msg, botUserId) {
  const thread_ts = msg.thread_ts || msg.ts;
  console.log(`\n--- New report: ${msg.text.slice(0, 80)}`);
  await slack.postMessage(onItMessage(), thread_ts);

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
    const posted = await slack.postMessage(proposalMessage(decision, notes), thread_ts);
    pendingApprovals.set(thread_ts, { decision, notes, proposalTs: posted.ts });
    persist();
    console.log(`Proposal posted, awaiting approval: ${decision.title}`);
    return;
  }

  const issue = await execute(decision, { thread_ts, guardrailNotes: notes });
  console.log(`Filed ${issue.identifier} (${decision.severity}) -> ${decision.assignee_github || "triage queue"}`);
}

async function main() {
  const botUserId = await slack.getBotUserId();
  let lastTs = String(Date.now() / 1000); // only react to messages after startup
  console.log(`triage-agent watching Slack channel ${config.slackChannel} (bot ${botUserId})`);

  // Watcher: escalations + component health
  setInterval(() => sweep().catch((e) => console.error("watcher:", e.message)), config.watchIntervalSec * 1000);

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
        await handleReport(msg, botUserId).catch(async (e) => {
          console.error("triage failed:", e);
          await slack.postMessage(triageFailedMessage(e.message), msg.thread_ts || msg.ts);
        });
      }
      // Poll threads awaiting approval: a reply (approve/yes/lgtm/…) or a
      // reaction (✅/👍) on the proposal message from ANY human counts.
      for (const [t, pending] of [...pendingApprovals]) {
        let verdict = null;

        const replies = await slack.fetchThread(t);
        const last = replies[replies.length - 1];
        if (last && last.user !== botUserId && !last.bot_id) {
          const text = (last.text || "").trim();
          if (APPROVE_TEXT.test(text)) verdict = "approve";
          else if (REJECT_TEXT.test(text)) verdict = "reject";
        }

        if (!verdict && pending.proposalTs) {
          try {
            const reactions = await slack.getReactions(pending.proposalTs);
            if (reactions.some((r) => APPROVE_REACTIONS.has(r))) verdict = "approve";
            else if (reactions.some((r) => REJECT_REACTIONS.has(r))) verdict = "reject";
          } catch (e) {
            // reactions:read scope not granted yet — reply-based approval still works
            if (!String(e.message).includes("missing_scope")) console.error("reactions:", e.message);
          }
        }

        if (verdict === "approve") {
          pendingApprovals.delete(t);
          persist();
          const issue = await execute(pending.decision, { thread_ts: t, guardrailNotes: pending.notes });
          console.log(`Approved and filed ${issue.identifier}`);
        } else if (verdict === "reject") {
          pendingApprovals.delete(t);
          persist();
          await slack.postMessage(rejectedMessage(), t);
          console.log(`Rejected: ${pending.decision.title}`);
        }
        // anything else in the thread: keep waiting
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
