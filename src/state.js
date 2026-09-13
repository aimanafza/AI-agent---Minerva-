// Pending approvals/questions survive restarts via a local state file.
// Without this, a restart orphans every open proposal thread.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../.state.json", import.meta.url).pathname;

export function loadState() {
  try {
    const s = JSON.parse(readFileSync(FILE, "utf8"));
    return {
      pendingApprovals: s.pendingApprovals || {},
      pendingQuestions: s.pendingQuestions || [],
    };
  } catch {
    return { pendingApprovals: {}, pendingQuestions: [] };
  }
}

export function saveState({ pendingApprovals, pendingQuestions }) {
  writeFileSync(
    FILE,
    JSON.stringify({
      pendingApprovals: Object.fromEntries(pendingApprovals),
      pendingQuestions: [...pendingQuestions],
    })
  );
}
