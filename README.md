# Mamdani — AI triage and sprint-planning agent

A PM copilot that turns raw bug reports into evidence-backed Linear tickets, then helps plan the next sprint. It does the investigation and ticket-updating. A human still reviews and approves every write.

## The problem

Bug triage is a real, daily bottleneck for product managers. A QA engineer drops a one-line report in Slack or creates a ticket in Linear Triage. Someone then has to reconstruct the bug, hunt for duplicates across differently worded tickets, decide severity, figure out which part of the product is affected, assign an owner, label it, and later decide whether it belongs in this cycle or stays in the backlog. That work is spread across Slack, Linear, GitHub, and Notion. It is slow, easy to get wrong, and it repeats on every report.

The cost of getting it wrong is concrete. A P1 filed as a P3 sits until a customer hits it. Two tickets for the same Safari login failure get two different owners. A vague "swipe is broken" becomes a guessed assignee with no evidence. Urgent work in a deferred area steals a sprint from the cycle's actual goal. The PM spends the afternoon coordinating tools instead of deciding what the team should build.

Existing tools do not close this loop. Slack is where the report lands. Linear is an inbox, not an investigator. GitHub already knows who owns the code (`CODEOWNERS`, commit history) but nobody opens it for every bug. Notion has the cycle priorities, and they get ignored under time pressure. So teams either rubber-stamp tickets or the PM becomes a human router between four apps.

Mamdani exists because that routing job is necessary and automatable — and because replacing the PM is the wrong goal. The agent investigates, cites evidence, and proposes. The PM still accepts, rejects, or edits. Tickets only move to Backlog, and into a cycle, when a human says so.

## What we built

QA reports a bug in Slack (`#bugs`) or creates an untriaged Linear ticket (no assignee, no priority). The agent acknowledges it, then investigates before guessing:

- recent Linear issues, compared by meaning, not keywords (so "login broken on Safari" can match "auth fails on WebKit")
- the GitHub repo: file paths for the affected area, `CODEOWNERS` for policy ownership, and recent commits for who actually works on that code
- Notion handbook pages for cycle focus (a bug in this cycle's area is weighted up; an explicitly deferred area is weighted down)

If the report is too thin to set severity, it asks the reporter **one** impact question in the Slack thread (users, platforms, money, workaround) instead of inventing a priority.

When it has enough, it posts a **proposal** in Slack: clearer title, severity (P0–P3), suggested owner, duplicate status, labels, and evidence for each claim. The PM can approve, reject, or reply with an edit. Approve files or updates Linear and moves the issue to **Backlog**. Reject does nothing. The agent never assigns an owner without code-level evidence — no evidence means the triage queue, with the reason stated.

A second command, `!sprint`, drafts a sprint from the live Linear backlog plus the handbook: who takes which tickets, which project they belong to, and what is deliberately deferred. Replies revise the plan; a checkmark **locks** it and writes cycle, assignees, and projects to Linear.

After filing, a watcher escalates stale unassigned P0/P1s in Slack and flags components that are generating a cluster of bugs.

Writes are never "the model said so." The agent must end on a structured `submit_triage` (or `ask_reporter`). Deterministic guardrails then strip unevidenced owners, invented duplicates, phantom file paths, ungrounded urgent severity, and cycle/priority claims that were not backed by a retrieved Notion page. Only then can a human approve a write.

```
Slack report  ──┐
                ├─► orchestrator (Claude + tools)
Linear triage ──┘         │
                    Linear / GitHub / Notion (read)
                          │
                    submit_triage or ask_reporter
                          │
                    guardrails (code)
                          │
              Slack proposal ── approve / reject / edit
                          │
                    Linear Backlog (create or update)
                          │
              !sprint ── lock ── cycle + assignees + projects
                          │
                    watcher: P1 escalation, component heat
```

## Apps

The core loop uses **three** apps. Notion is a fourth, optional handbook.

| App | Role |
|---|---|
| **Slack** | Intake (`#bugs`), follow-up questions, proposals, approve / reject / edit, `!sprint`, `!health`, escalations |
| **Linear** | Duplicate corpus, create or update tickets, move approved work to Backlog, cycles / projects on sprint lock |
| **GitHub** | Affected files by path, `CODEOWNERS`, recent commit authors |
| Notion (optional) | Cycle priorities and ownership docs — used to weigh severity and to draft sprints |

Slack is polled. Linear Triage intake is polled on the watcher interval: a new issue with no assignee and no priority starts the same propose → approve loop; on approve the **existing** ticket is updated in place (not duplicated).

## How to run

```bash
npm install
cp .env.example .env   # fill in keys — comments in the file explain each one
npm start              # Slack poller + Linear watcher
```

Required in `.env`: `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `LINEAR_API_KEY`, `LINEAR_TEAM_KEY`, `GITHUB_TOKEN`, `GITHUB_REPO`, `USER_MAP` (GitHub login → Linear email). Invite the Slack bot to the channel. `NOTION_API_KEY` and `PM_MAP` are optional.

Then, in the Slack channel:

1. Post a bug report. The bot proposes in the thread. Reply `approve`, `reject`, or tell it what to change.
2. Or create an unassigned, no-priority issue in Linear — the bot posts a proposal in Slack for that ticket.
3. `!sprint` drafts a sprint from the live backlog. Reply to revise; react ✅ to lock and write it to Linear.
4. `!health` prints a component-heat report for the last 7 days.

`REQUIRE_APPROVAL=true` (default) always waits for a human before writing Linear.

Check keys without running the agent:

```bash
npm run smoke
```

## How we tested reliability

The eval harness (`npm run eval`) runs the **same** agent — same tools, same prompt — over 24 labeled wardrobe-app reports in `eval/reports.json`. It captures the `submit_triage` decision and does not write to Slack or Linear. There is no test-only code path.

Each report has ground-truth severity, owner (or triage queue), duplicate target, and whether the agent should ask a follow-up instead of deciding. The mix includes clear-cut bugs, paraphrased duplicates of seeded Linear tickets, thin reports (`should_ask: true`), deferred-area cases, and unowned/ambiguous code (correct owner is `null`).

| Metric | Result |
|---|---|
| Severity accuracy | 21/24 (88%) |
| Owner accuracy | 22/24 (92%) |
| Duplicate precision | 100% (9/9 flagged were real) |
| Duplicate recall | 100% (9/9 real dupes found) |
| Thin reports asked instead of guessed | 3/3 |

Final run, 24 reports:

| Metric | Result |
|---|---|
| Severity accuracy | 21/24 (88%) |
| Owner accuracy | 22/24 (92%) |
| Duplicate precision | 100% (9/9 flagged were real) |
| Duplicate recall | 100% (9/9 real dupes found) |
| Thin reports asked instead of guessed | 3/3 |
| Tickets written without human approval | 0 (enforced by code) |

The eval earned its keep during the build: our first run scored 54% on severity and exposed a real bug — the `UNGROUNDED_SEVERITY` guardrail was silently capping urgent severities (including a P0 data-loss case) to P2 whenever the model paraphrased its evidence instead of quoting the report. We fixed both sides of the contract (the prompt must quote; the guardrail accepts a verbatim quoted span) and severity went 54% to 79% to 88% across runs. Remaining misses: two over-cautious follow-up questions on genuinely ambiguous reports and one duplicate-severity alignment. Reruns vary a few points from LLM nondeterminism, and the answer key tracks the live workspace (CODEOWNERS, existing tickets), so it must be kept in sync with the world.

```bash
npm run eval          # scores the live agent on eval/reports.json
npm test              # guardrail unit tests (no network)
```

`npm test` checks the guardrails in isolation: no owner without retrieved `CODEOWNERS` or commit logins, no invented duplicate, no phantom path, urgent severity must be quoted from the report, cycle/priority claims need a real Notion read. Target for "tickets filed without evidence" is 0 — that is enforced in code, not in the prompt.

We also smoke-tested each integration (`npm run smoke`) and ran the live Slack loop: intake, follow-up, approve, reject, in-thread edits, Linear-originated tickets, `!sprint` lock, and watcher escalations.

## Demo

2-minute demo video: **[LINK — paste before submitting]**

## Team

- Nazym Zhiyengaliyeva — nazym@uni.minerva.edu (GitHub: Nazym-MU)
- Aiman Afzal — afzal@uni.minerva.edu (GitHub: aimanafza)
- Arina Alibayeva — arina@uni.minerva.edu (GitHub: arinaalibayeva)
