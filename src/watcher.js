import { config } from "./config.js";
import * as linear from "./linear.js";
import * as slack from "./slack.js";
import { loadWatcherState, saveWatcherState } from "./state.js";
import { escalationMessage, quietWeekMessage, componentHealthMessage } from "./voice.js";

// After filing, keep watching:
// 1. A P0/P1 that sits unassigned or unstarted past the threshold gets escalated in Slack.
// 2. A component (label) producing too many bugs in 7 days gets a health ping to the PM.
// Persisted (.state.json) so a restart doesn't re-fire every escalation/ping.
const persistedWatcher = loadWatcherState();
const escalated = new Set(persistedWatcher.escalated);
const heatPinged = new Set(persistedWatcher.heatPinged);
let linearSeen = persistedWatcher.linearSeen === null ? null : new Set(persistedWatcher.linearSeen);
const persist = () => saveWatcherState({ escalated, heatPinged, linearSeen });

// A ticket created directly in Linear that nobody triaged: no assignee AND no
// priority. (Mamdani's own tickets always get a priority, so they're excluded.)
function isUntriaged(i) {
  return i.priority === 0 && !i.assignee && i.stateType !== "completed" && i.stateType !== "canceled";
}

// Returns newly-detected untriaged Linear tickets for index.js to run through
// the same propose->approve loop. First sweep seeds silently.
export async function sweep() {
  const issues = await linear.recentIssues(100);
  const now = Date.now();

  let newlyUntriaged = [];
  if (linearSeen === null) {
    linearSeen = new Set(issues.filter(isUntriaged).map((i) => i.identifier));
    persist();
  } else {
    newlyUntriaged = issues.filter((i) => isUntriaged(i) && !linearSeen.has(i.identifier));
    if (newlyUntriaged.length) {
      for (const i of newlyUntriaged) linearSeen.add(i.identifier);
      persist();
    }
  }

  // 1. Stale urgent issues
  for (const i of issues) {
    if (i.priority !== 1) continue; // urgent only
    if (i.stateType === "completed" || i.stateType === "canceled") continue;
    const ageMin = (now - new Date(i.createdAt).getTime()) / 60000;
    const stale = !i.assignee || i.stateType === "triage" || i.stateType === "backlog" || i.stateType === "unstarted";
    if (stale && ageMin > config.escalateAfterMin && !escalated.has(i.identifier)) {
      escalated.add(i.identifier);
      persist();
      await slack.postMessage(escalationMessage(i.identifier, i.title, Boolean(i.assignee), ageMin));
    }
  }

  // 2. Component heat
  await healthReport(issues, false);

  return newlyUntriaged;
}

// Component-health report. force=true (the !health command) reports the top
// components regardless of threshold and repeats even if already pinged.
export async function healthReport(issues = null, force = true) {
  issues = issues || (await linear.recentIssues(100));
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const counts = {};
  for (const i of issues) {
    if (new Date(i.createdAt).getTime() < weekAgo) continue;
    for (const label of i.labels) counts[label] = (counts[label] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const hot = entries.filter(([label, count]) => (force ? count > 0 : count >= config.heatThreshold && !heatPinged.has(label)));

  if (force && !hot.length) {
    await slack.postMessage(quietWeekMessage());
    return;
  }
  for (const [label, count] of hot.slice(0, force ? 3 : hot.length)) {
    if (!force) {
      heatPinged.add(label);
      persist();
    }
    const assignees = issues
      .filter((i) => i.labels.includes(label) && i.assignee)
      .map((i) => i.assignee);
    const top = mostCommon(assignees);
    const topCount = top ? assignees.filter((a) => a === top).length : 0;
    await slack.postMessage(componentHealthMessage(label, count, top, topCount, count >= config.heatThreshold));
  }
}

function mostCommon(arr) {
  if (!arr.length) return null;
  const c = {};
  for (const x of arr) c[x] = (c[x] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
}
