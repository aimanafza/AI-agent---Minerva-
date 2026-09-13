import { config } from "./config.js";
import * as linear from "./linear.js";
import * as slack from "./slack.js";
import { filedMessage, duplicateNotedMessage } from "./voice.js";

// Takes a validated triage decision and performs the writes:
// create the Linear ticket (Slack entry point) or update the existing one
// in place (direct-in-Linear entry point), then report back in the thread.
export async function execute(decision, { thread_ts, permalink, guardrailNotes, updateIssue }) {
  let assigneeId = null;
  let assigneeLabel = "triage queue";

  if (decision.assignee_github) {
    // Tolerant lookup: strip a leading @, match case-insensitively, and fall
    // back to substring matching so "nazym" still finds "Nazym-MU".
    const raw = decision.assignee_github.replace(/^@/, "").toLowerCase();
    const key = Object.keys(config.userMap).find(
      (k) => k.toLowerCase() === raw || k.toLowerCase().includes(raw) || raw.includes(k.toLowerCase())
    );
    const email = key ? config.userMap[key] : null;
    const user = email ? await linear.findUserByEmail(email) : null;
    if (user) {
      assigneeId = user.id;
      assigneeLabel = user.name;
    } else {
      assigneeLabel = `triage queue (no Linear user mapped for GitHub @${decision.assignee_github})`;
      console.log(`assignee mapping failed: "${decision.assignee_github}" not in USER_MAP [${Object.keys(config.userMap).join(", ")}]`);
    }
  }

  const description = [
    decision.summary,
    "",
    `**Severity rationale:** ${decision.severity_evidence}`,
    decision.affected_paths?.length ? `**Affected code:** ${decision.affected_paths.join(", ")}` : "",
    decision.assignee_github
      ? `**Owner rationale:** ${decision.assignee_evidence}`
      : `**In triage queue:** ${decision.triage_queue_reason}`,
    decision.duplicate_of ? `**Possible duplicate of:** ${decision.duplicate_of} (${decision.duplicate_confidence} confidence)` : "",
    permalink ? `**Original report:** ${permalink}` : "",
    "",
    "_Filed by triage-agent_",
  ]
    .filter(Boolean)
    .join("\n");

  let issue;
  if (updateIssue) {
    issue = await linear.updateIssue({
      id: updateIssue.id,
      severity: decision.severity,
      assigneeId,
      labels: decision.labels,
    });
    await linear.addComment(updateIssue.id, `Triage (approved in Slack):\n\n${description}`).catch(() => {});
  } else {
    issue = await linear.createIssue({
      title: decision.title,
      description,
      severity: decision.severity,
      assigneeId,
      labels: decision.labels,
    });
  }

  const lines = [
    filedMessage(issue, decision, assigneeLabel),
    decision.duplicate_of ? duplicateNotedMessage(decision) : null,
    ...(guardrailNotes || []),
  ].filter(Boolean);

  await slack.postMessage(lines.join("\n"), thread_ts);
  return issue;
}
