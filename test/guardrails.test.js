import test from "node:test";
import assert from "node:assert/strict";
import { enforceGuardrails } from "../src/guardrails.js";

function baseDecision(overrides = {}) {
  return {
    title: "Test ticket",
    summary: "Something is broken.",
    severity: "P2",
    severity_evidence: "",
    affected_paths: [],
    assignee_github: null,
    assignee_evidence: "",
    triage_queue_reason: null,
    duplicate_of: null,
    duplicate_confidence: "none",
    labels: [],
    ...overrides,
  };
}

test("missing severity is recovered from a P0-P3 token in severity_evidence", async () => {
  const decision = baseDecision({
    severity: undefined,
    severity_evidence: "reporter flagged this as P3, just a cosmetic typo",
  });

  const { decision: out, fired } = await enforceGuardrails(decision, [], "typo on the pricing page");

  assert.equal(out.severity, "P3");
  assert.ok(fired.some((f) => f.code === "MISSING_SEVERITY"));
});

test("missing severity with no recoverable token falls back to P2", async () => {
  const decision = baseDecision({
    severity: undefined,
    severity_evidence: "no clear signal on urgency here",
  });

  const { decision: out, fired } = await enforceGuardrails(decision, [], "something is off");

  assert.equal(out.severity, "P2");
  assert.ok(fired.some((f) => f.code === "MISSING_SEVERITY"));
});

test("assignee present in CODEOWNERS text survives", async () => {
  const trace = [
    {
      tool: "github_codeowners",
      input: {},
      result: "/backend/app/api/routes/auth.py @arinaalibayeva\n",
      ms: 5,
    },
  ];
  const decision = baseDecision({
    assignee_github: "arinaalibayeva",
    assignee_evidence: "CODEOWNERS assigns auth.py to @arinaalibayeva",
  });

  const { decision: out, fired } = await enforceGuardrails(decision, trace, "auth is broken");

  assert.equal(out.assignee_github, "arinaalibayeva");
  assert.deepEqual(fired, []);
});

test("assignee present only in commit logins survives", async () => {
  const trace = [
    {
      tool: "github_recent_commits",
      input: { path: "backend/app/api/routes/wardrobe.py" },
      result: [{ login: "Nazym-MU", name: "Nazym", date: "2026-09-01", message: "fix upload bug" }],
      ms: 5,
    },
  ];
  const decision = baseDecision({
    assignee_github: "Nazym-MU",
    assignee_evidence: "Nazym-MU is the most recent committer on this path",
  });

  const { decision: out, fired } = await enforceGuardrails(decision, trace, "wardrobe upload is broken");

  assert.equal(out.assignee_github, "Nazym-MU");
  assert.deepEqual(fired, []);
});

test("invented assignee found in neither source is nulled", async () => {
  const trace = [
    { tool: "github_codeowners", input: {}, result: "/backend/app/api/routes/auth.py @arinaalibayeva\n", ms: 5 },
    {
      tool: "github_recent_commits",
      input: { path: "backend/app/api/routes/auth.py" },
      result: [{ login: "arinaalibayeva", name: "Arina", date: "2026-09-01", message: "fix" }],
      ms: 5,
    },
  ];
  const decision = baseDecision({
    assignee_github: "ghost-user",
    assignee_evidence: "ghost-user usually handles this kind of bug",
  });

  const { decision: out, fired } = await enforceGuardrails(decision, trace, "auth is broken");

  assert.equal(out.assignee_github, null);
  assert.ok(out.triage_queue_reason);
  assert.ok(fired.some((f) => f.code === "UNEVIDENCED_ASSIGNEE"));
});

test("duplicate_of matching a retrieved identifier survives", async () => {
  const trace = [
    {
      tool: "linear_recent_issues",
      input: {},
      result: [{ identifier: "ENG-12", title: "Auth fails on WebKit" }],
      ms: 5,
    },
  ];
  const decision = baseDecision({
    duplicate_of: "ENG-12",
    duplicate_confidence: "high",
  });

  const { decision: out, fired } = await enforceGuardrails(decision, trace, "login broken on safari");

  assert.equal(out.duplicate_of, "ENG-12");
  assert.deepEqual(fired, []);
});

test("duplicate_of that was never retrieved is nulled", async () => {
  const trace = [
    { tool: "linear_recent_issues", input: {}, result: [{ identifier: "ENG-1", title: "Unrelated issue" }], ms: 5 },
  ];
  const decision = baseDecision({
    duplicate_of: "ENG-999",
    duplicate_confidence: "high",
  });

  const { decision: out, fired } = await enforceGuardrails(decision, trace, "login broken on safari");

  assert.equal(out.duplicate_of, null);
  assert.equal(out.duplicate_confidence, "none");
  assert.ok(fired.some((f) => f.code === "UNRETRIEVED_DUPLICATE"));
});

test("P1 severity with evidence quoted from the report stays P1", async () => {
  const reportText =
    "Checkout is broken for all users, no workaround exists, we are losing money every minute this stays up.";
  const decision = baseDecision({
    severity: "P1",
    severity_evidence: "no workaround exists, losing money every minute",
  });

  const { decision: out, fired } = await enforceGuardrails(decision, [], reportText);

  assert.equal(out.severity, "P1");
  assert.ok(!fired.some((f) => f.code === "UNGROUNDED_SEVERITY"));
});

test("P1 severity with evidence not in the report is capped to P2", async () => {
  const reportText = "Login page shows a blank screen for some users.";
  const decision = baseDecision({
    severity: "P1",
    severity_evidence: "thousands of dollars lost every single hour of downtime",
  });

  const { decision: out, fired } = await enforceGuardrails(decision, [], reportText);

  assert.equal(out.severity, "P2");
  assert.ok(fired.some((f) => f.code === "UNGROUNDED_SEVERITY"));
});

test("nonexistent affected path is dropped", async () => {
  const trace = [
    {
      tool: "github_find_files",
      input: { query: "avatar" },
      result: ["backend/app/api/routes/avatar.py"],
      ms: 5,
    },
  ];
  const decision = baseDecision({
    affected_paths: ["backend/app/api/routes/avatar.py", "backend/app/api/routes/does_not_exist.py"],
  });

  const { decision: out, fired } = await enforceGuardrails(decision, trace, "avatar generation is broken");

  assert.deepEqual(out.affected_paths, ["backend/app/api/routes/avatar.py"]);
  const phantom = fired.find((f) => f.code === "PHANTOM_PATH");
  assert.ok(phantom);
  assert.match(phantom.detail, /does_not_exist\.py/);
});

test("policy claim backed by a retrieved notion_read_page survives", async () => {
  const trace = [
    {
      tool: "notion_read_page",
      input: { page_id: "abc123" },
      result: "## Cycle 14 priorities\nWardrobe upload is the current cycle's focus area.",
      ms: 8,
    },
  ];
  const decision = baseDecision({
    severity: "P2",
    severity_evidence: "wardrobe upload is the current cycle's focus area per the Cycle 14 priorities page",
  });

  const { decision: out, fired } = await enforceGuardrails(decision, trace, "wardrobe upload is broken");

  assert.equal(out.severity_evidence, decision.severity_evidence);
  assert.ok(!fired.some((f) => f.code === "UNCITED_POLICY"));
});

test("policy claim with no retrieved notion page is stripped", async () => {
  const decision = baseDecision({
    severity: "P2",
    severity_evidence: "this is deprioritized for the current cycle so it doesn't matter much.",
  });

  const { decision: out, fired } = await enforceGuardrails(decision, [], "the settings page looks slightly off");

  assert.ok(!/cycle/i.test(out.severity_evidence));
  assert.ok(fired.some((f) => f.code === "UNCITED_POLICY"));
});
