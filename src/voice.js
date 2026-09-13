// Single source of truth for how the agent talks. Every user-facing string
// (Slack messages) lives here so tone stays consistent instead of drifting
// file by file.

export const VOICE_RULES = `Voice — how you write every user-facing string (titles, summaries, evidence):
- lowercase by default. capitalize only proper nouns, file paths, ticket ids, and @handles.
- short sentences. one idea per sentence. no sentence over ~20 words.
- no emoji, anywhere, ever.
- no hedging filler: "might be worth", "it seems", "this appears to be", "I'd suggest".
- state the thing, then the reason, then stop.
- evidence is a quote plus one clause, not an essay.
- never explain a rubric back to the reader. say "p3, cosmetic, has a workaround" not "per the handbook's Bug Triage & Priority Policy, P3 covers cosmetic issues with limited functional impact, which matches...".
- no em dashes.`;

export const SEVERITY_GLOSS = {
  P0: "drop everything",
  P1: "fix today",
  P2: "fix this week",
  P3: "whenever",
};

// "P1" -> "P1 (fix today)" — plain text, no bold. Callers that want the code
// itself bolded wrap decision.severity separately and append this gloss.
function glossOf(severity) {
  return SEVERITY_GLOSS[severity] ? `(${SEVERITY_GLOSS[severity]})` : "";
}

// --- Slack messages -------------------------------------------------------

export function onItMessage(reporterUserId) {
  return reporterUserId
    ? `hang on a sec <@${reporterUserId}>, checking duplicates and finding an owner <3`
    : "hang on a sec, checking duplicates and finding an owner <3";
}

export function followUpQuestionMessage(question) {
  return `before I file this — ${question}`;
}

export function rejectedMessage() {
  return "dropped it, nothing filed. logged your reason.";
}

export function triageFailedMessage(errorMessage) {
  return `that one broke on me: ${errorMessage}`;
}

export function proposalMessage(decision, notes) {
  const blocks = [
    "triage proposal — reply *approve* to file, or *reject <reason>*",
    `*${decision.title}*`,
    `severity: *${decision.severity}* ${glossOf(decision.severity)}\n${decision.severity_evidence}`,
    decision.assignee_github
      ? `owner: *@${decision.assignee_github}*\n${decision.assignee_evidence}`
      : `owner: *triage queue*\n${decision.triage_queue_reason}`,
  ];
  if (decision.duplicate_of) {
    blocks.push(`duplicate of *${decision.duplicate_of}* (${decision.duplicate_confidence} confidence)`);
  }
  if (decision.labels?.length) {
    blocks.push(`labels: ${decision.labels.join(", ")}`);
  }
  if (notes?.length) {
    blocks.push(notes.join("\n"));
  }
  return blocks.join("\n\n");
}

export function linearTicketDetectedMessage(identifier, title) {
  return `new ticket went straight into Linear: *${identifier} — ${title}*. triaging it now`;
}

export function sprintDraftingMessage() {
  return "drafting a sprint proposal from the backlog and the handbook, give me a minute";
}

export function sprintLockedMessage() {
  return "sprint plan locked. final version above. see you monday.";
}

export function revisedProposalMessage(decision, notes) {
  return `revised proposal\n\n${proposalMessage(decision, notes)}`;
}

export function filedMessage(issue, decision, assigneeLabel) {
  return `filed as <${issue.url}|${issue.identifier}>, ${decision.severity} ${glossOf(decision.severity)}, assigned to ${assigneeLabel}`;
}

export function duplicateNotedMessage(decision) {
  return `looks like a duplicate of ${decision.duplicate_of}. noted it on the ticket.`;
}

export function escalationMessage(identifier, title, isAssigned, ageMin) {
  const severity = "P1"; // watcher only escalates Linear's "urgent" priority
  return `${identifier} is ${severity} ${glossOf(severity)} and has been ${isAssigned ? "untouched" : "unassigned"} for ${Math.round(ageMin)} min\n"${title}"\n\nsomeone needs to pick this up`;
}

export function quietWeekMessage() {
  return "no bugs filed in the last 7 days. quiet week.";
}

export function componentHealthMessage(label, count, topAssignee, topCount, isHot) {
  const bugWord = count === 1 ? "bug" : "bugs";
  const assigneeClause = topAssignee ? `, ${topCount} assigned to ${topAssignee}` : "";
  const base = `${label} has ${count} ${bugWord} this week${assigneeClause}`;
  return isHot ? `${base}\n\nworth looking at the component, not just the tickets` : base;
}
