import { config } from "./config.js";
import * as slack from "./slack.js";
import { triage, enforceGuardrails } from "./orchestrator.js";
import { execute } from "./executor.js";
import { sweep, healthReport } from "./watcher.js";

// Threads where we asked the reporter a follow-up and are waiting for an answer.
const pendingQuestions = new Set();
// Threads where a triage proposal awaits PM approval: thread_ts -> {decision, notes}
const pendingApprovals = new Map();

function formatProposal(decision, notes) {
  return [
    `:clipboard: *Triage proposal* — reply *approve* to file, or *reject <reason>*.`,
    `*${decision.title}*`,
    `• Severity: *${decision.severity}* — ${decision.severity_evidence}`,
    decision.assignee_github
      ? `• Owner: *@${decision.assignee_github}* — ${decision.assignee_evidence}`
      : `• Owner: *triage queue* — ${decision.triage_queue_reason}`,
    decision.duplicate_of
      ? `• Possible duplicate of *${decision.duplicate_of}* (${decision.duplicate_confidence} confidence)`
      : null,
    decision.labels?.length ? `• Labels: ${decision.labels.join(", ")}` : null,
    ...(notes || []),
  ]
    .filter(Boolean)
    .join("\n");
}

async function handleReport(msg, botUserId) {
  const thread_ts = msg.thread_ts || msg.ts;
  console.log(`\n--- New report: ${msg.text.slice(0, 80)}`);
  await slack.postMessage(":mag: On it — checking for duplicates and finding an owner…", thread_ts);

  // If this is a reply in a thread we asked a question in, feed the whole thread back.
  let threadContext = [];
  if (msg.thread_ts && pendingQuestions.has(msg.thread_ts)) {
    const replies = await slack.fetchThread(msg.thread_ts);
    threadContext = replies.map((m) => `${m.user === botUserId ? "agent" : "reporter"}: ${m.text}`);
    pendingQuestions.delete(msg.thread_ts);
  }

  const result = await triage(msg.text, threadContext);

  if (result.kind === "question") {
    pendingQuestions.add(thread_ts);
    await slack.postMessage(`:question: Before I file this: ${result.question}`, thread_ts);
    console.log(`Asked follow-up: ${result.question}`);
    return;
  }

  const { decision, notes } = enforceGuardrails(result.decision);

  if (config.requireApproval) {
    pendingApprovals.set(thread_ts, { decision, notes });
    await slack.postMessage(formatProposal(decision, notes), thread_ts);
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
          await slack.postMessage(`:warning: Triage failed: ${e.message}`, msg.thread_ts || msg.ts);
        });
      }
      // Poll threads awaiting PM approval
      for (const [t, pending] of [...pendingApprovals]) {
        const replies = await slack.fetchThread(t);
        const last = replies[replies.length - 1];
        if (!last || last.user === botUserId || last.bot_id) continue;
        const text = (last.text || "").trim().toLowerCase();
        if (text.startsWith("approve")) {
          pendingApprovals.delete(t);
          const issue = await execute(pending.decision, { thread_ts: t, guardrailNotes: pending.notes });
          console.log(`Approved and filed ${issue.identifier}`);
        } else if (text.startsWith("reject")) {
          pendingApprovals.delete(t);
          await slack.postMessage(":x: Understood — dropped, nothing was filed. The decision and your reason are logged.", t);
          console.log(`Rejected: ${pending.decision.title} — "${last.text}"`);
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
