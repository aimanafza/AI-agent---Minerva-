// Eval harness: runs the SAME agent (same tools, same prompt) over labeled
// reports, but captures the submit_triage decision instead of writing anywhere.
// Usage: npm run eval  (optionally: node eval/run.js eval/reports.json)
import { readFileSync } from "node:fs";
import { triage, enforceGuardrails } from "../src/orchestrator.js";

const file = process.argv[2] || new URL("./reports.json", import.meta.url).pathname;
const reports = JSON.parse(readFileSync(file, "utf8"));

const rows = [];
let sevHit = 0, ownerHit = 0;
let dupTP = 0, dupFP = 0, dupFN = 0;
let asked = 0;
let guardrailFires = 0;

for (const r of reports) {
  process.stdout.write(`[${r.id}] ${r.text.slice(0, 60)}... `);
  let out;
  try {
    out = await triage(r.text);
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    rows.push({ id: r.id, error: e.message });
    continue;
  }

  if (out.kind === "question") {
    asked++;
    const ok = r.expected.should_ask === true;
    console.log(`asked follow-up ${ok ? "(expected ✓)" : "(NOT expected ✗)"}`);
    rows.push({ id: r.id, asked: true, ok });
    if (ok) { sevHit++; ownerHit++; } // asking when it should ask counts as correct
    continue;
  }

  const { decision: d, fired } = await enforceGuardrails(out.decision, out.trace, r.text);
  const e = r.expected;

  const sevOk = d.severity === e.severity;
  const ownerOk = (d.assignee_github || null) === (e.assignee_github || null);
  if (sevOk) sevHit++;
  if (ownerOk) ownerHit++;

  const predDup = d.duplicate_of || null;
  const trueDup = e.duplicate_of || null;
  if (predDup && predDup === trueDup) dupTP++;
  else if (predDup && predDup !== trueDup) dupFP++;
  if (trueDup && predDup !== trueDup) dupFN++;

  guardrailFires += fired.length;
  console.log(
    `sev ${d.severity}${sevOk ? "✓" : `✗(want ${e.severity})`} | owner ${d.assignee_github || "queue"}${ownerOk ? "✓" : `✗(want ${e.assignee_github || "queue"})`} | dup ${predDup || "-"}` +
      (fired.length ? ` | guardrails: ${fired.map((f) => f.code).join(", ")}` : "")
  );
  rows.push({ id: r.id, severity: d.severity, sevOk, owner: d.assignee_github, ownerOk, dup: predDup, fired: fired.map((f) => f.code) });
}

const n = reports.length;
const dupPrecision = dupTP + dupFP ? (dupTP / (dupTP + dupFP)) : 1;
const dupRecall = dupTP + dupFN ? (dupTP / (dupTP + dupFN)) : 1;

console.log("\n================ RESULTS ================");
console.log(`Reports:               ${n}`);
console.log(`Severity accuracy:     ${sevHit}/${n} (${((100 * sevHit) / n).toFixed(0)}%)`);
console.log(`Owner accuracy:        ${ownerHit}/${n} (${((100 * ownerHit) / n).toFixed(0)}%)`);
console.log(`Duplicate precision:   ${(100 * dupPrecision).toFixed(0)}%  (${dupTP} right of ${dupTP + dupFP} flagged)`);
console.log(`Duplicate recall:      ${(100 * dupRecall).toFixed(0)}%  (${dupTP} of ${dupTP + dupFN} real dupes found)`);
console.log(`Follow-ups asked:      ${asked}`);
console.log(`Guardrails fired:      ${guardrailFires}`);
console.log("=========================================");
