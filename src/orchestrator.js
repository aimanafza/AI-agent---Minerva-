import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import * as linear from "./linear.js";
import * as github from "./github.js";
import * as notion from "./notion.js";

const anthropic = new Anthropic({ apiKey: config.anthropicKey });

const TOOLS = [
  {
    name: "linear_recent_issues",
    description:
      "List the ~100 most recently updated Linear issues (title, id, priority, state, assignee, labels). Use this to check for duplicates by MEANING, not keywords — 'login button broken on Safari' may duplicate 'Auth fails on WebKit'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "github_search_code",
    description:
      "Search the product repo's code for a term from the bug report (an error string, component name, endpoint, UI copy). Returns matching file paths. Use to locate which files the bug points to.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "search term, e.g. 'checkout' or an error message fragment" } },
      required: ["query"],
    },
  },
  {
    name: "github_codeowners",
    description: "Fetch the repo's CODEOWNERS file. Maps path patterns to owning GitHub users/teams.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "github_recent_commits",
    description: "List the last 10 commits touching a specific file path, with author GitHub logins. Use to find who actually works on this code.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "file path in the repo" } },
      required: ["path"],
    },
  },
  {
    name: "notion_cycle_priorities",
    description:
      "Read the team's current-cycle priorities page from Notion (cycle focus areas, priority rules, deferrals). Use it to weigh priority: a bug in this cycle's focus area matters more; something the page explicitly defers matters less. Cite the page in your severity_evidence when it changes your call.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "ask_reporter",
    description:
      "TERMINAL. The report is too thin to determine severity. Ask the reporter ONE follow-up question in the Slack thread instead of guessing. You are a PM triaging, NOT an engineer debugging: ask about impact (how many users, which platforms, is money involved, is there a workaround) — never ask the reporter to debug, open dev tools, or read logs.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
  {
    name: "submit_triage",
    description:
      "TERMINAL. Submit your final triage decision. Every claim needs evidence: severity_evidence quotes the report; assignee_evidence cites CODEOWNERS lines or commit history you actually retrieved. If you could not find code-level evidence for an owner, set assignee to null and explain in triage_queue_reason.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Clear, specific ticket title (symptom + surface), e.g. 'Checkout: card form rejects valid Amex numbers'" },
        summary: { type: "string", description: "2-4 sentence description for the ticket body" },
        severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        severity_evidence: { type: "string", description: "Quote from the report supporting severity: user count, money involved, workaround existence" },
        affected_paths: { type: "array", items: { type: "string" }, description: "Repo file paths this bug points to, from your code search" },
        assignee_github: { type: ["string", "null"], description: "GitHub login of the proposed owner, or null for triage queue" },
        assignee_evidence: { type: "string", description: "Why this person: CODEOWNERS match and/or recent commits on affected paths. Empty string if assignee is null." },
        triage_queue_reason: { type: ["string", "null"], description: "If assignee is null: why no owner could be determined" },
        duplicate_of: { type: ["string", "null"], description: "Linear identifier (e.g. ENG-42) of the likely duplicate, or null" },
        duplicate_confidence: { type: "string", enum: ["high", "medium", "none"] },
        labels: { type: "array", items: { type: "string" }, description: "Component labels, e.g. ['checkout', 'frontend']" },
      },
      required: [
        "title", "summary", "severity", "severity_evidence", "affected_paths",
        "assignee_github", "assignee_evidence", "triage_queue_reason",
        "duplicate_of", "duplicate_confidence", "labels",
      ],
    },
  },
];

const SYSTEM = `You are Mamdani, a PM's bug triage agent for an engineering team. You receive a raw bug report and must produce one triage decision: title, severity, owner, duplicates, labels. You are a project manager, not an engineer: you never attempt to diagnose root causes, suggest fixes, or ask reporters to debug — you route the bug to the right person with the right priority and move on.

Rules — these are hard constraints:
1. NEVER assign an owner without code-level evidence. Evidence means: you searched the code, found the affected paths, and either CODEOWNERS covers those paths or the commit history shows who works on them. A hunch or a name mentioned in the report is NOT evidence. Without evidence, assign to the triage queue (assignee_github: null) and say why.
2. NEVER invent severity. Severity comes from the report: user impact, money involved, availability of a workaround. Rubric: P0 = outage or data loss, all/most users. P1 = core flow broken, money involved, or no workaround. P2 = feature broken but workaround exists. P3 = cosmetic, minor. If the report is too thin to place it, use ask_reporter — one specific question.
3. Check duplicates by meaning. Read the recent Linear issues and compare the underlying problem, not the words. Different words for the same failure = duplicate (high). Same area but different failure = not a duplicate (mention it as related in summary instead).
4. Investigate before deciding: typically linear_recent_issues first (cheap duplicate check), then github_search_code with a distinctive term from the report, then codeowners/commits on the paths you find. Check notion_cycle_priorities when deciding severity: a bug in the current cycle's focus area gets weighted up, an explicitly deferred area down — and cite the cycle page in severity_evidence when it changed your call. Keep it to a few focused calls.
5. End with exactly one terminal call: submit_triage or ask_reporter.`;

async function runTool(name, input) {
  switch (name) {
    case "linear_recent_issues":
      return await linear.recentIssues();
    case "github_search_code":
      return await github.searchCode(input.query);
    case "github_codeowners":
      return (await github.getCodeowners()) ?? "No CODEOWNERS file found.";
    case "github_recent_commits":
      return await github.recentCommits(input.path);
    case "notion_cycle_priorities":
      return notion.notionEnabled()
        ? await notion.getCyclePriorities()
        : "Notion is not configured — triage without cycle context.";
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// Runs the agentic loop on a bug report. Returns either
// { kind: "triage", decision, trace } or { kind: "question", question, trace }.
export async function triage(reportText, threadContext = []) {
  const messages = [
    {
      role: "user",
      content:
        `New bug report from Slack:\n\n"""\n${reportText}\n"""\n` +
        (threadContext.length
          ? `\nEarlier conversation in this thread (oldest first):\n${threadContext.map((m) => `- ${m}`).join("\n")}`
          : ""),
    },
  ];
  const trace = [];

  for (let turn = 0; turn < 12; turn++) {
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: 2000,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    });

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      // Model answered in prose without a terminal tool — nudge it once.
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: "End with a terminal tool call: submit_triage or ask_reporter." });
      continue;
    }

    const terminal = toolUses.find((t) => t.name === "submit_triage" || t.name === "ask_reporter");
    if (terminal) {
      trace.push({ tool: terminal.name, input: terminal.input });
      if (terminal.name === "ask_reporter") {
        return { kind: "question", question: terminal.input.question, trace };
      }
      return { kind: "triage", decision: terminal.input, trace };
    }

    messages.push({ role: "assistant", content: response.content });
    const results = [];
    for (const tu of toolUses) {
      let result;
      try {
        result = await runTool(tu.name, tu.input);
      } catch (err) {
        result = `Tool error: ${err.message}`;
      }
      trace.push({ tool: tu.name, input: tu.input });
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result).slice(0, 20000),
      });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("Triage did not terminate within 12 turns");
}

// Deterministic guardrails — enforced in code, not in the prompt.
export function enforceGuardrails(decision) {
  const notes = [];
  if (decision.assignee_github && !decision.assignee_evidence?.trim()) {
    notes.push("Guardrail: assignee proposed without evidence — routed to triage queue instead.");
    decision.assignee_github = null;
    decision.triage_queue_reason = "No code-level evidence for an owner.";
  }
  if (decision.duplicate_of && decision.duplicate_confidence === "none") {
    decision.duplicate_of = null;
  }
  return { decision, notes };
}
