// Single source of truth for how the agent talks. Every user-facing string
// (Slack messages) lives here so tone stays consistent instead of drifting
// file by file.

export const VOICE_RULES = `Voice — how you write every user-facing string (titles, summaries, evidence):
- lowercase by default. capitalize only proper nouns, file paths, ticket ids, and @handles.
- short sentences. one idea per sentence. no sentence over ~20 words.
- no emoji except a single leading status glyph on a message (:white_check_mark:, :rotating_light:, :question:, :clipboard:). never emoji elsewhere.
- no hedging filler: "might be worth", "it seems", "this appears to be", "I'd suggest".
- state the thing, then the reason, then stop.
- evidence is a quote plus one clause, not an essay.
- never explain a rubric back to the reader. say "p3, cosmetic, has a workaround" not "per the handbook's Bug Triage & Priority Policy, P3 covers cosmetic issues with limited functional impact, which matches...".
- no em dashes.`;

// --- Slack messages -------------------------------------------------------

export function onItMessage() {
  return ":mag: on it. checking duplicates and finding an owner.";
}

export function followUpQuestionMessage(question) {
  return `:question: before filing this: ${question}`;
}

export function rejectedMessage() {
  return ":x: dropped. nothing filed. logged with your reason.";
}

export function triageFailedMessage(errorMessage) {
  return `:warning: triage failed: ${errorMessage}`;
}

export function proposalMessage(decision, notes) {
  const lines = [
    ":clipboard: triage proposal. reply *approve* to file, or *reject <reason>*.",
    `*${decision.title}*`,
    `• severity: *${decision.severity}*`,
    `    ${decision.severity_evidence}`,
    decision.assignee_github ? `• owner: *@${decision.assignee_github}*` : "• owner: *triage queue*",
    decision.assignee_github ? `    ${decision.assignee_evidence}` : `    ${decision.triage_queue_reason}`,
    decision.duplicate_of ? `• duplicate of *${decision.duplicate_of}* (${decision.duplicate_confidence} confidence)` : null,
    decision.labels?.length ? `• labels: ${decision.labels.join(", ")}` : null,
    ...(notes || []),
  ];
  return lines.filter(Boolean).join("\n");
}

export function filedMessage(issue, decision, assigneeLabel) {
  return `:white_check_mark: filed as *<${issue.url}|${issue.identifier}>*, ${decision.severity}, assigned to *${assigneeLabel}*.`;
}

export function duplicateNotedMessage(decision) {
  return `:link: duplicate of *${decision.duplicate_of}* (${decision.duplicate_confidence} confidence). noted in the ticket.`;
}

export function escalationMessage(identifier, title, isAssigned, ageMin) {
  return `:rotating_light: *${identifier}* is P1, ${isAssigned ? "untouched" : "unassigned"} for ${Math.round(ageMin)} min.\n"${title}"\nescalating. someone needs to pick this up.`;
}

export function quietWeekMessage() {
  return ":thermometer: no bugs filed in the last 7 days. quiet week.";
}

export function componentHealthMessage(label, count, topAssignee, topCount, isHot) {
  const bugWord = count === 1 ? "bug" : "bugs";
  const assigneeClause = topAssignee ? `, ${topCount} assigned to ${topAssignee}` : "";
  const base = `:thermometer: *${label}* has ${count} ${bugWord} this week${assigneeClause}.`;
  return isHot ? `${base} worth looking at the component, not just the tickets.` : base;
}
