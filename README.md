# mamdani

mamdani is an AI triage agent that turns raw bug reports into correctly filed, correctly owned Linear tickets — and keeps watching them afterward.

A bug report lands in Slack (our demo: an internal QA team reporting bugs on a deployed AI wardrobe app). The agent checks Linear for semantic duplicates ("login button broken on Safari" matches "Auth fails on WebKit"), derives severity from evidence in the report (users affected, money involved, workaround or not), then finds the owner from the code itself: it searches the GitHub repo for the affected files, reads CODEOWNERS, and checks who actually committed to those paths recently. It posts a triage **proposal** in the thread — title, severity, owner, duplicates, each with its evidence — and waits for the PM to reply `approve` (or `reject`). Only then does it file the Linear ticket. Afterward it watches: a P1 that sits unassigned gets escalated, and a component generating repeated bugs gets flagged to the PM. The PM's entire job becomes reading one message and typing one word.

**Guardrails (enforced in code, not prompts):** the agent never assigns without code-level evidence — no evidence means triage queue, with the reason stated. It never invents severity from a thin report — it asks the reporter one follow-up question in the thread instead.

## Architecture

One orchestrator agent (Claude, tool-use loop) with read-only investigation tools. It must terminate with a structured `submit_triage` decision carrying evidence for every claim. Deterministic code then validates the decision (guardrails) and performs all writes. The eval harness runs the identical agent and scores the decision instead of executing it — no test-only code paths.

```
Slack (#bugs) ──> orchestrator (Claude)
                    ├─ linear_recent_issues     (duplicate check, semantic)
                    ├─ github_find_files        (locate affected files by path)
                    ├─ github_codeowners        (ownership by policy)
                    ├─ github_recent_commits    (ownership in practice)
                    └─ submit_triage / ask_reporter  (terminal, structured, evidenced)
                          │
                  guardrail validation (code)
                          │
              proposal in Slack thread ──"approve"──> Linear ticket + confirmation
                          │                └─"reject"──> dropped, logged
                          │
                  watcher: P1 escalation + component-health pings
```

## External apps (4)

| App | Used for | Integration |
|---|---|---|
| Slack | Report intake, replies, escalations | Web API (poll + post) |
| Linear | Duplicate corpus, ticket creation | GraphQL API |
| GitHub | Code search, CODEOWNERS, commit history | REST API |
| Notion | Current-cycle priorities: bugs in the cycle's focus area get weighted up, deferred areas down, with the page cited | REST API |

## How to run

```bash
npm install
cp .env.example .env   # fill in keys — see comments in the file
npm start              # starts the Slack poller + watcher
```

Post a bug report in the configured Slack channel and watch the thread.

## Reliability testing

We wrote 24 labeled bug reports (`eval/reports.json`) against our live Linear workspace, GitHub repo, and Notion handbook — each with ground-truth severity, owner, and duplicate target decided in advance from CODEOWNERS and the seeded tickets. `npm run eval` runs the *identical* agent (same prompt, same tools, no test-only code paths) over all of them and scores each field. The set deliberately includes paraphrased duplicates, reports that are too thin to file (correct answer: ask the reporter), bugs in code nobody owns (correct answer: triage queue), and a near-duplicate trap the handbook warns about (a generic login complaint that must NOT match the existing Safari issue).

Final run (24 reports):

| Metric | Result |
|---|---|
| Severity accuracy | 21/24 (88%) |
| Owner accuracy | 22/24 (92%) |
| Duplicate precision | 100% (9/9 flagged were real) |
| Duplicate recall | 100% (9/9 real dupes found) |
| Thin reports -> asked instead of guessed | 3/3 |
| Tickets written without human approval | 0 (enforced by code) |

The eval earned its keep during the build: our first run scored 54% on severity and exposed a real bug — the `UNGROUNDED_SEVERITY` guardrail was silently capping urgent severities (including a P0 data-loss case) to P2 whenever the model paraphrased its evidence instead of quoting the report. We fixed both sides of the contract (the prompt must quote; the guardrail accepts a verbatim quoted span) and severity went 54% -> 79% -> 88% across runs. The remaining misses are two over-cautious follow-up questions on genuinely ambiguous reports and one duplicate-severity alignment.

Guardrails are unit-tested separately (`npm test`, 12 tests): unevidenced assignees route to the triage queue, duplicates must exist among retrieved tickets, hallucinated file paths are dropped, and policy citations require an actual Notion read in the tool trace. Note: reruns vary a few points due to LLM nondeterminism, and expected owners/duplicates track the live workspace (CODEOWNERS and existing tickets), so the answer key must be kept in sync with the world.

We also verified the full write path live: reports with no code signal route to the triage queue, under-specified reports trigger a follow-up question rather than a guessed severity, and rejected proposals leave nothing behind in Linear.

## Demo

TODO: 2-minute video link

## Team

TODO: names + emails
