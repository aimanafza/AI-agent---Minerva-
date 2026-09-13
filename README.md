# Triage Agent

An AI agent that turns raw bug reports into correctly filed, correctly owned Linear tickets — and keeps watching them afterward.

A bug report lands in Slack (our demo: an internal QA team reporting bugs on a deployed AI wardrobe app). The agent checks Linear for semantic duplicates ("login button broken on Safari" matches "Auth fails on WebKit"), derives severity from evidence in the report (users affected, money involved, workaround or not), then finds the owner from the code itself: it searches the GitHub repo for the affected files, reads CODEOWNERS, and checks who actually committed to those paths recently. It posts a triage **proposal** in the thread — title, severity, owner, duplicates, each with its evidence — and waits for the PM to reply `approve` (or `reject`). Only then does it file the Linear ticket. Afterward it watches: a P1 that sits unassigned gets escalated, and a component generating repeated bugs gets flagged to the PM. The PM's entire job becomes reading one message and typing one word.

**Guardrails (enforced in code, not prompts):** the agent never assigns without code-level evidence — no evidence means triage queue, with the reason stated. It never invents severity from a thin report — it asks the reporter one follow-up question in the thread instead.

## Architecture

One orchestrator agent (Claude, tool-use loop) with read-only investigation tools. It must terminate with a structured `submit_triage` decision carrying evidence for every claim. Deterministic code then validates the decision (guardrails) and performs all writes. The eval harness runs the identical agent and scores the decision instead of executing it — no test-only code paths.

```
Slack (#bugs) ──> orchestrator (Claude)
                    ├─ linear_recent_issues     (duplicate check, semantic)
                    ├─ github_search_code       (locate affected files)
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
| _(4th: Gmail or Sentry — TODO if added)_ | Alternate intake | — |

## How to run

```bash
npm install
cp .env.example .env   # fill in keys — see comments in the file
npm start              # starts the Slack poller + watcher
```

Post a bug report in the configured Slack channel and watch the thread.

## Reliability testing

We wrote N labeled bug reports (`eval/reports.json`) against a seeded Linear workspace and GitHub repo — each with ground-truth severity, owner, and duplicate target decided by us in advance. `npm run eval` runs the identical agent over all of them and scores each field.

| Metric | Result |
|---|---|
| Severity accuracy | TODO |
| Owner accuracy | TODO |
| Duplicate precision | TODO |
| Duplicate recall | TODO |
| Tickets filed without evidence | TODO (target: 0, enforced by code) |

We also verified the guardrails directly: reports with no code signal route to the triage queue, and under-specified reports trigger a follow-up question rather than a guessed severity.

## Demo

TODO: 2-minute video link

## Team

TODO: names + emails
