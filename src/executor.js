import { config } from "./config.js";
import * as linear from "./linear.js";
import * as slack from "./slack.js";

// Takes a validated triage decision and performs the writes:
// create the Linear ticket, then report back in the Slack thread.
export async function execute(decision, { thread_ts, permalink, guardrailNotes }) {
  let assigneeId = null;
  let assigneeLabel = "triage queue";

  if (decision.assignee_github) {
    const email = config.userMap[decision.assignee_github];
    const user = email ? await linear.findUserByEmail(email) : null;
    if (user) {
      assigneeId = user.id;
      assigneeLabel = user.name;
    } else {
      assigneeLabel = `triage queue (no Linear user mapped for GitHub @${decision.assignee_github})`;
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

  const issue = await linear.createIssue({
    title: decision.title,
    description,
    severity: decision.severity,
    assigneeId,
    labels: decision.labels,
  });

  const lines = [
    `:white_check_mark: Filed as *<${issue.url}|${issue.identifier}>* — ${decision.severity}, assigned to *${assigneeLabel}*.`,
    decision.duplicate_of
      ? `:link: Possible duplicate of *${decision.duplicate_of}* (${decision.duplicate_confidence} confidence) — noted in the ticket.`
      : null,
    ...(guardrailNotes || []),
  ].filter(Boolean);

  await slack.postMessage(lines.join("\n"), thread_ts);
  return issue;
}
