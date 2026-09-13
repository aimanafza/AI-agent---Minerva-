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
    max_tokens: 4000,
    messages: [
      {
        role: "user",
        content: `You are Mamdani, the team's PM agent, drafting a proposal for next week's sprint. This is a PROPOSAL for the humans to react to in the thread — do not present it as a decision.

Open Linear backlog (priority: 1=urgent 2=high 3=medium 4=low):
${backlog}

Team handbook (policy, ownership, product):${handbook || "\n(no handbook access — plan from the backlog alone)"}

Engineers: Arina (auth, trips, packing), Nazym (wardrobe, uploads, extension), Aiman (styling, looks, avatar, AI).

Produce, in Slack mrkdwn (*bold*, bullets), under 3000 characters:
1. *Sprint focus* — one sentence naming the theme the backlog is begging for.
2. *Proposed sprint* — per engineer: the ticket ids to take, in order, one-line rationale each. Balance load; respect handbook priorities.
3. *Deliberately deferred* — ticket ids left out and why (one line each).
4. *Patterns worth a project* — 1-2 recurring-bug clusters that suggest structural work rather than one-off fixes, each grounded in the ticket ids that evidence it.
End with: "React ✅ to adopt as the sprint draft, or reply with changes."`,
      },
    ],
  });

  return resp.content.find((b) => b.type === "text")?.text || "(no proposal generated)";
}
