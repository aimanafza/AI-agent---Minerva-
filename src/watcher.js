import { config } from "./config.js";
import * as linear from "./linear.js";
import * as slack from "./slack.js";

// After filing, keep watching:
// 1. A P0/P1 that sits unassigned or unstarted past the threshold gets escalated in Slack.
// 2. A component (label) producing too many bugs in 7 days gets a health ping to the PM.
const escalated = new Set();
const heatPinged = new Set();

export async function sweep() {
  const issues = await linear.recentIssues(100);
  const now = Date.now();

  // 1. Stale urgent issues
  for (const i of issues) {
    if (i.priority !== 1) continue; // urgent only
    if (i.stateType === "completed" || i.stateType === "canceled") continue;
    const ageMin = (now - new Date(i.createdAt).getTime()) / 60000;
    const stale = !i.assignee || i.stateType === "triage" || i.stateType === "backlog" || i.stateType === "unstarted";
    if (stale && ageMin > config.escalateAfterMin && !escalated.has(i.identifier)) {
      escalated.add(i.identifier);
      await slack.postMessage(
        `:rotating_light: *${i.identifier}* is P1 and has been ${i.assignee ? "untouched" : "unassigned"} for ${Math.round(ageMin)} min: "${i.title}". Escalating — someone needs to pick this up.`
      );
    }
  }

  // 2. Component heat
  await healthReport(issues, false);
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
    await slack.postMessage(":thermometer: Component health: no bugs filed in the last 7 days. Quiet week.");
    return;
  }
  for (const [label, count] of hot.slice(0, force ? 3 : hot.length)) {
    if (!force) heatPinged.add(label);
    const assignees = issues
      .filter((i) => i.labels.includes(label) && i.assignee)
      .map((i) => i.assignee);
    const top = mostCommon(assignees);
    await slack.postMessage(
      `:thermometer: Component health: *${label}* has produced ${count} bug${count === 1 ? "" : "s"} this week` +
        (top ? `, ${assignees.filter((a) => a === top).length} assigned to ${top}` : "") +
        (count >= config.heatThreshold ? `. Might be worth a look beyond individual tickets.` : ".")
    );
  }
}

function mostCommon(arr) {
  if (!arr.length) return null;
  const c = {};
  for (const x of arr) c[x] = (c[x] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
}
