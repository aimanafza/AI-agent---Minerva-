// Pending approvals/questions, and the watcher's escalation/heat memory,
// survive restarts via a shared local state file. Without this, a restart
// orphans every open proposal thread and re-fires every escalation.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../.state.json", import.meta.url).pathname;

function readFile() {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

// Merge-write so index.js and watcher.js, which persist different keys of
// the same file, never clobber each other's half.
function writeFile(partial) {
  writeFileSync(FILE, JSON.stringify({ ...readFile(), ...partial }));
}

export function loadState() {
  const s = readFile();
  return {
    pendingApprovals: s.pendingApprovals || {},
    pendingQuestions: s.pendingQuestions || [],
  };
}

export function saveState({ pendingApprovals, pendingQuestions }) {
  writeFile({
    pendingApprovals: Object.fromEntries(pendingApprovals),
    pendingQuestions: [...pendingQuestions],
  });
}

export function loadWatcherState() {
  const s = readFile();
  return {
    escalated: s.escalated || [],
    heatPinged: s.heatPinged || [],
    // null (never seeded) is meaningful: first sweep seeds without triaging,
    // so booting the bot doesn't storm an existing backlog.
    linearSeen: s.linearSeen ?? null,
  };
}

export function saveWatcherState({ escalated, heatPinged, linearSeen }) {
  writeFile({
    escalated: [...escalated],
    heatPinged: [...heatPinged],
    ...(linearSeen ? { linearSeen: [...linearSeen] } : {}),
  });
}
