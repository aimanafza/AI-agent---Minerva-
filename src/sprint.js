// Proactive planning: on-demand sprint proposal from the live Linear backlog
// plus handbook policy. Trigger with `!sprint` in the channel (or wire it to a
// weekly schedule in production). Proposes only — humans decide, same as triage.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import * as linear from "./linear.js";
import * as notion from "./notion.js";

const anthropic = new Anthropic({ apiKey: config.anthropicKey });

export async function sprintProposal() {
  const issues = await linear.recentIssues(100);
  const open = issues.filter((i) => !["completed", "canceled"].includes(i.stateType));
  const cycle = await linear.getUpcomingCycle().catch(() => null);
  const projects = await linear.listProjects().catch(() => []);
  const cycleLine = cycle
    ? `Sprint container: cycle ${cycle.number}, ${cycle.startsAt.slice(0, 10)} to ${cycle.endsAt.slice(0, 10)}. The deadline for everything in this sprint is ${cycle.endsAt.slice(0, 10)}.`
    : "No cycle found; plan a one-week sprint.";
  const projectLines = projects.length
    ? `Existing Linear projects: ${projects.map((p) => p.name).join(" | ")}. Slot tickets into these when they fit.`
    : "No projects exist yet.";

  let handbook = "";
  if (notion.notionEnabled()) {
    const pages = await notion.searchPages("");
    const relevant = pages
      .filter((p) => /priorit|policy|ownership|routing|product|feature/i.test(p.title))
      .slice(0, 3);
    for (const p of relevant) {
      try {
        handbook += `\n\n# ${p.title}\n${await notion.readPage(p.id)}`;
      } catch {
        // skip unreadable pages; plan from the backlog alone
      }
    }
  }

  const backlog = open
    .map(
      (i) =>
        `${i.identifier} [P${i.priority}] (${i.labels.join(",") || "unlabeled"}) ${
          i.assignee ? `assigned:${i.assignee}` : "unassigned"
        } — ${i.title}`
    )
    .join("\n");

  const resp = await anthropic.messages.create({
    model: config.model,
    max_tokens: 12000,
    messages: [
      {
        role: "user",
        content: `You are mamdani, the team's PM agent, drafting a proposal for next week's sprint. This is a PROPOSAL for the humans to react to in the thread — do not present it as a decision.

Open Linear backlog (priority: 1=urgent 2=high 3=medium 4=low):
${backlog}

Team handbook (policy, ownership, product):${handbook || "\n(no handbook access — plan from the backlog alone)"}

Engineers: Nazym (wardrobe, uploads, extension, auth, waitlist), Aiman (styling, looks, avatar, AI, trips, packing). Arina is the PM — she approves plans and NEVER takes tickets.

${cycleLine}
${projectLines}

Produce, in Slack mrkdwn (*bold*, bullets), under 3000 characters:
1. *sprint title and goal* — a name for this sprint, its one-sentence goal, and the deadline (the cycle end date).
2. *proposed sprint* — per engineer: the ticket ids to take, in order, one-line rationale each, and which project each belongs to (an existing project when it fits). Balance load; respect handbook priorities.
3. *deliberately deferred* — ticket ids left out and why (one line each).
4. *project proposals* — if tickets cluster around work no existing project covers, propose 1-2 new projects: name, goal, and the ticket ids that would seed them.
Voice: lowercase by default, no emoji, short sentences, no hedging filler.
End with: "react with a checkmark to lock this sprint. on lock I move these tickets into the cycle with these assignees. or reply with changes."`,
      },
    ],
  });

  const text = resp.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`empty response (stop: ${resp.stop_reason}) — token budget too small?`);
  return text;
}

// On lock: turn the final plan text into structured assignments (forced tool
// call) and commit them to Linear — cycle, assignee, project per ticket.
const COMMIT_TOOL = {
  name: "commit_sprint",
  description: "Commit the locked sprint plan as structured assignments.",
  input_schema: {
    type: "object",
    properties: {
      sprint_title: { type: "string" },
      assignments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            identifier: { type: "string", description: "Linear id like WAR-12" },
            assignee_github: { type: "string" },
            project_name: { type: ["string", "null"], description: "existing project name, or null" },
          },
          required: ["identifier", "assignee_github", "project_name"],
        },
      },
    },
    required: ["sprint_title", "assignments"],
  },
};

function linearUserEmailFor(githubLogin) {
  const raw = (githubLogin || "").replace(/^@/, "").toLowerCase();
  const key = Object.keys(config.userMap).find(
    (k) => k.toLowerCase() === raw || k.toLowerCase().includes(raw) || raw.includes(k.toLowerCase())
  );
  return key ? config.userMap[key] : null;
}

export async function applySprintPlan(finalPlanText) {
  const resp = await anthropic.messages.create({
    model: config.model,
    max_tokens: 8000,
    tools: [COMMIT_TOOL],
    tool_choice: { type: "tool", name: "commit_sprint" },
    messages: [
      {
        role: "user",
        content: `Extract the final sprint assignments from this locked plan. Only tickets going INTO the sprint (skip deferred ones). assignee_github must be one of: ${Object.keys(config.userMap).join(", ")}.\n\n${finalPlanText}`,
      },
    ],
  });
  const tu = resp.content.find((b) => b.type === "tool_use" && b.name === "commit_sprint");
  if (!tu) throw new Error("could not extract assignments from the plan");

  const cycle = await linear.getUpcomingCycle();
  const projects = await linear.listProjects().catch(() => []);
  const issues = await linear.recentIssues(100);
  const byIdentifier = new Map(issues.map((i) => [i.identifier.toUpperCase(), i]));

  const done = [];
  const skipped = [];
  for (const a of tu.input.assignments || []) {
    const issue = byIdentifier.get((a.identifier || "").toUpperCase());
    if (!issue) {
      skipped.push(`${a.identifier} (not found)`);
      continue;
    }
    const email = linearUserEmailFor(a.assignee_github);
    const user = email ? await linear.findUserByEmail(email) : null;
    const project = a.project_name
      ? projects.find((p) => p.name.toLowerCase().includes(a.project_name.toLowerCase()) || a.project_name.toLowerCase().includes(p.name.toLowerCase()))
      : null;
    try {
      await linear.assignIssueToSprint({
        id: issue.id,
        cycleId: cycle?.id,
        assigneeId: user?.id,
        projectId: project?.id,
      });
      done.push(`${issue.identifier} -> ${user?.name || a.assignee_github}${project ? ` (${project.name})` : ""}`);
    } catch (e) {
      skipped.push(`${issue.identifier} (${e.message.slice(0, 60)})`);
    }
  }

  const cycleName = cycle ? `cycle ${cycle.number} (ends ${cycle.endsAt.slice(0, 10)})` : "the sprint";
  return [
    `written to Linear: "${tu.input.sprint_title}" — ${done.length} ticket${done.length === 1 ? "" : "s"} into ${cycleName}`,
    ...done.map((d) => `• ${d}`),
    ...(skipped.length ? [`skipped: ${skipped.join(", ")}`] : []),
  ].join("\n");
}

// Revise the current sprint plan from PM feedback in the thread — the
// back-and-forth of a live planning session.
export async function revisePlan(previousPlan, transcript) {
  const resp = await anthropic.messages.create({
    model: config.model,
    max_tokens: 12000,
    messages: [
      {
        role: "user",
        content: `You are mamdani, the team's PM agent, in a live sprint-planning conversation. Revise the sprint plan below according to the PM feedback from the thread. Keep everything they didn't ask to change.

Current plan:
${previousPlan}

Thread so far (newest last):
${transcript}

Reply with the FULL revised plan in the same Slack mrkdwn format, under 3000 characters. Voice: lowercase by default, no emoji, short sentences. First line: *revised:* plus a one-sentence summary of what changed. End with: "react with a checkmark to lock this plan, or keep the feedback coming."`,
      },
    ],
  });
  return resp.content.find((b) => b.type === "text")?.text || previousPlan;
}
