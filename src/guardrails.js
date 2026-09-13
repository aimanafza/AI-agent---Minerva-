// Deterministic guardrails — enforced in code, not in the prompt.
// Pure module: no imports from config.js/github.js/notion.js, so it's importable
// (and unit-testable) without network access or env vars.

export function buildEvidence(trace) {
  const e = { codeowners: "", commitLogins: new Set(), linearIds: new Set(), treePaths: new Set() };
  for (const step of trace) {
    if (step.tool === "github_codeowners" && typeof step.result === "string") {
      e.codeowners += "\n" + step.result;
    }
    if (step.tool === "github_recent_commits" && Array.isArray(step.result)) {
      for (const c of step.result) if (c.login) e.commitLogins.add(c.login.toLowerCase());
    }
    if (step.tool === "linear_recent_issues" && Array.isArray(step.result)) {
      for (const i of step.result) if (i.identifier) e.linearIds.add(i.identifier.toUpperCase());
    }
    if (step.tool === "github_find_files" && Array.isArray(step.result)) {
      for (const p of step.result) e.treePaths.add(typeof p === "string" ? p : p.path);
    }
  }
  return e;
}

function contentWords(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
}

// A "successful" notion_read_page call: it actually returned page text, not a
// disabled-integration placeholder or a tool error.
function hasEvidencedNotionRead(trace) {
  return trace.some((step) => {
    if (step.tool !== "notion_read_page") return false;
    const r = step.result;
    return (
      typeof r === "string" &&
      r !== "Notion is not configured — triage without handbook context." &&
      !r.startsWith("Tool error:")
    );
  });
}

const POLICY_PATTERN =
  /\b(cycle|sprint|roadmap|priorit(?:y|ies|ize[sd]?|ization)|deprioritiz(?:e[sd]?|ation)|deferred|backlog)\b/i;

// Drop sentences that reference cycle/priority/roadmap policy from a field,
// leaving ordinary reasoning untouched.
function stripPolicyClaims(text) {
  if (!text) return { text, stripped: false };
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !POLICY_PATTERN.test(s));
  if (kept.length === sentences.length) return { text, stripped: false };
  return { text: kept.join(" ").trim(), stripped: true };
}

// treeHasPath: optional async (path) => boolean for a live confirmation beyond
// what the trace already shows. Defaults to "not confirmed" so this module
// stays dependency-free; orchestrator.js supplies the real one (github.treeHasPath).
export async function enforceGuardrails(decision, trace, reportText, treeHasPath = async () => false) {
  const notes = [];
  const fired = [];
  const evidence = buildEvidence(trace);

  // Existing check: assignee proposed with an empty evidence string.
  if (decision.assignee_github && !decision.assignee_evidence?.trim()) {
    notes.push("Guardrail: assignee proposed without evidence — routed to triage queue instead.");
    fired.push({ code: "EMPTY_ASSIGNEE_EVIDENCE", detail: `assignee ${decision.assignee_github} had empty assignee_evidence` });
    decision.assignee_github = null;
    decision.triage_queue_reason = "No code-level evidence for an owner.";
  }

  // CHECK 1: assignee must be backed by retrieved evidence (CODEOWNERS text or commit logins).
  if (decision.assignee_github) {
    const login = decision.assignee_github.toLowerCase();
    const backed = evidence.codeowners.toLowerCase().includes(login) || evidence.commitLogins.has(login);
    if (!backed) {
      notes.push(`Guardrail: no retrieved evidence supports @${decision.assignee_github} as owner — routed to triage queue instead.`);
      fired.push({ code: "UNEVIDENCED_ASSIGNEE", detail: `@${decision.assignee_github} not found in retrieved CODEOWNERS text or commit logins` });
      decision.assignee_github = null;
      decision.triage_queue_reason = "No retrieved evidence supports this owner.";
    }
  }

  // Existing rule: "none" confidence always clears duplicate_of.
  if (decision.duplicate_of && decision.duplicate_confidence === "none") {
    decision.duplicate_of = null;
  }

  // CHECK 2: duplicate must be a real retrieved issue.
  if (decision.duplicate_of) {
    const dup = decision.duplicate_of.toUpperCase();
    if (!evidence.linearIds.has(dup)) {
      notes.push(`Guardrail: duplicate_of ${decision.duplicate_of} was not among the retrieved Linear issues — cleared.`);
      fired.push({ code: "UNRETRIEVED_DUPLICATE", detail: `${decision.duplicate_of} not present in retrieved linear_recent_issues` });
      decision.duplicate_of = null;
      decision.duplicate_confidence = "none";
    }
  }

  // CHECK 3: affected paths must exist in the repo tree.
  if (Array.isArray(decision.affected_paths) && decision.affected_paths.length) {
    const kept = [];
    const dropped = [];
    for (const p of decision.affected_paths) {
      if (evidence.treePaths.has(p)) {
        kept.push(p);
        continue;
      }
      let confirmed = false;
      try {
        confirmed = await treeHasPath(p);
      } catch {
        confirmed = false;
      }
      if (confirmed) kept.push(p);
      else dropped.push(p);
    }
    if (dropped.length) {
      notes.push(`Guardrail: dropped affected path(s) not found in the repo tree: ${dropped.join(", ")}`);
      fired.push({ code: "PHANTOM_PATH", detail: `dropped: ${dropped.join(", ")}` });
      decision.affected_paths = kept;
    }
  }

  // CHECK 4: urgent severity evidence must be grounded in the report text.
  if (decision.severity === "P0" || decision.severity === "P1") {
    const evWords = contentWords(decision.severity_evidence);
    const reportWords = new Set(contentWords(reportText));
    const matched = evWords.filter((w) => reportWords.has(w)).length;
    const ratio = evWords.length ? matched / evWords.length : 0;
    if (ratio < 0.6) {
      notes.push(
        `Guardrail: severity_evidence isn't grounded in the report — urgent severity requires evidence quoted from the report. Capped ${decision.severity} to P2.`
      );
      fired.push({ code: "UNGROUNDED_SEVERITY", detail: `only ${matched}/${evWords.length} evidence words found in report text` });
      decision.severity = "P2";
    }
  }

  // CHECK 5: a cycle/priority/roadmap claim in severity_evidence or summary needs an
  // actual notion_read_page call behind it — otherwise it's a fabricated policy citation.
  const citesPolicy = POLICY_PATTERN.test(decision.severity_evidence || "") || POLICY_PATTERN.test(decision.summary || "");
  if (citesPolicy && !hasEvidencedNotionRead(trace)) {
    const sev = stripPolicyClaims(decision.severity_evidence);
    const sum = stripPolicyClaims(decision.summary);
    if (sev.stripped || sum.stripped) {
      decision.severity_evidence = sev.text;
      decision.summary = sum.text;
      notes.push("Guardrail: severity_evidence/summary cited a cycle/priority/roadmap decision with no retrieved Notion page behind it — claim removed.");
      fired.push({ code: "UNCITED_POLICY", detail: "policy/cycle claim removed; no notion_read_page call found in trace" });
    }
  }

  return { decision, notes, fired };
}
