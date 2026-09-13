import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import * as linear from "./linear.js";
import * as github from "./github.js";
import * as notion from "./notion.js";
import { enforceGuardrails as enforceGuardrailsPure, buildEvidence } from "./guardrails.js";
import { VOICE_RULES } from "./voice.js";

const anthropic = new Anthropic({ apiKey: config.anthropicKey });

const TOOLS = [
  {
    name: "linear_recent_issues",
    description:
      "List the ~100 most recently updated Linear issues (title, id, priority, state, assignee, labels). Use this to check for duplicates by MEANING, not keywords — 'login button broken on Safari' may duplicate 'Auth fails on WebKit'.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "github_find_files",
    description:
      "Find files in the product repo whose PATH matches words from the bug report (a component or feature name, e.g. 'avatar', 'upload', 'swipe', 'waitlist'). This matches file paths in the repo tree, not file contents — it is not full-text code search, so search with component/feature words rather than error-message fragments.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "component or feature words, e.g. 'avatar upload' or 'waitlist'" } },
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
    name: "notion_search_pages",
    description:
      "List pages in the team's Notion handbook (cycle priorities, team ownership, process docs). Optional query filters by title. Returns page titles and ids for notion_read_page.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "optional title filter, e.g. 'cycle' or 'priorities'" } },
      required: [],
    },
  },
  {
    name: "notion_read_page",
    description:
      "Read one Notion handbook page as text. Sub-pages are listed with their ids — read them with another call if relevant. Use the handbook to weigh priority: a bug in the current cycle's focus area matters more, an explicitly deferred area less. Cite the page title in severity_evidence when it changes your call.",
    input_schema: {
      type: "object",
      properties: { page_id: { type: "string", description: "page id from notion_search_pages or a SUB-PAGE listing" } },
      required: ["page_id"],
    },
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
        title: { type: "string", description: "one line, lowercase except proper nouns and paths. symptom plus surface." },
        summary: { type: "string", description: "2-3 short sentences. what breaks, where, what the user sees." },
        severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        severity_evidence: { type: "string", description: "max 2 sentences. for P0/P1 start with a verbatim quote from the report in double quotes, then one short clause of reasoning. never explain the rubric back to the reader. lowercase." },
        affected_paths: { type: "array", items: { type: "string" }, description: "Repo file paths this bug points to, from your code search" },
        assignee_github: { type: ["string", "null"], description: "GitHub login of the proposed owner, or null for triage queue" },
        assignee_evidence: { type: "string", description: "max 2 sentences. name the files plainly: drop the leading directories, don't quote the path verbatim. cite the CODEOWNERS line or the commits you retrieved. no restating the whole file." },
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

const SYSTEM = `You are mamdani, a PM's bug triage agent for an engineering team. You receive a raw bug report and must produce one triage decision: title, severity, owner, duplicates, labels. You are a project manager, not an engineer: you never attempt to diagnose root causes, suggest fixes, or ask reporters to debug — you route the bug to the right person with the right priority and move on.

Rules — these are hard constraints:
1. NEVER assign an owner without code-level evidence. Evidence means: you searched the code, found the affected paths, and either CODEOWNERS covers those paths or the commit history shows who works on them. A hunch or a name mentioned in the report is NOT evidence. Without evidence, assign to the triage queue (assignee_github: null) and say why.
2. NEVER invent severity. Severity comes from the report: user impact, money involved, availability of a workaround. Rubric: P0 = outage or data loss (records gone, nobody can sign in), all/most users. P1 = core flow broken for a whole platform/browser family, money involved, or no workaround. P2 = feature malfunctions but a usable workaround exists. P3 = cosmetic, stale-view, or minor presentation issues that don't block anything. For P0/P1, severity_evidence MUST begin with a verbatim quote from the report inside double quotes ("..."), then your rationale — an urgent severity without a direct quote will be downgraded. If the report is too thin to place it, use ask_reporter — one specific question.
3. Check duplicates by meaning. Read the recent Linear issues and compare the underlying problem, not the words. Different words for the same failure = duplicate (high). Same area but different failure = not a duplicate (mention it as related in summary instead). When you flag a high-confidence duplicate, align severity with the existing ticket's priority (urgent=P1, high=P2, medium=P3) unless the new report shows materially worse impact.
4. Investigate before deciding: typically linear_recent_issues first (cheap duplicate check), then github_find_files with component/feature words from the report (e.g. 'avatar', 'upload', 'swipe', 'waitlist') — it matches file paths, not file contents — then codeowners/commits on the paths you find. Consult the Notion handbook when deciding severity: notion_search_pages to find the current cycle/priorities page, notion_read_page to read it — a bug in the current cycle's focus area gets weighted up, an explicitly deferred area down, and cite the page title in severity_evidence when it changed your call. Don't read the whole handbook; one or two relevant pages is enough. Keep it to a few focused calls.
5. End with exactly one terminal call: submit_triage or ask_reporter.

${VOICE_RULES}`;

async function runTool(name, input) {
  switch (name) {
    case "linear_recent_issues":
      return await linear.recentIssues();
    case "github_find_files":
      return await github.findFiles(input.query);
    case "github_codeowners":
      return (await github.getCodeowners()) ?? "No CODEOWNERS file found.";
    case "github_recent_commits":
      return await github.recentCommits(input.path);
    case "notion_search_pages":
      return notion.notionEnabled()
        ? await notion.searchPages(input.query || "")
        : "Notion is not configured — triage without handbook context.";
    case "notion_read_page":
      return notion.notionEnabled()
        ? await notion.readPage(input.page_id)
        : "Notion is not configured — triage without handbook context.";
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
      const startedAt = Date.now();
      let result;
      try {
        result = await runTool(tu.name, tu.input);
      } catch (err) {
        result = `Tool error: ${err.message}`;
      }
      const ms = Date.now() - startedAt;
      trace.push({ tool: tu.name, input: tu.input, result, ms });
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

// Deterministic guardrails — enforced in code, not in the prompt. The actual
// logic lives in guardrails.js (dependency-free, for unit testing); here we
// wire in the live tree lookup for the PHANTOM_PATH check.
export async function enforceGuardrails(decision, trace, reportText) {
  return enforceGuardrailsPure(decision, trace, reportText, github.treeHasPath);
}

export { buildEvidence };
