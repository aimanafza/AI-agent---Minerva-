# Final stretch — submission at 4:00 PM PT

Status as of ~12:30: Slack phase DONE (intake, proposal, approve, reject, follow-up, !health, escalation all tested live). World DONE (pack-demo + CODEOWNERS + seeded Linear). Notion tool coded, waiting on integration token.

## Remaining, in priority order

### 1. Eval dataset — CRITICAL PATH (owner: Person 3 + Arina, target 1:15)
`eval/reports.json` → ~30 wardrobe bug reports with ground truth. Mix:
- ~10 clear-cut (obvious severity, clearly owned area per CODEOWNERS)
- ~8 paraphrased duplicates of seeded WAR-5..WAR-14 (different words, same bug)
- ~5 thin reports where the RIGHT answer is `"should_ask": true`
- ~4 touching the deferred AI-styling area (right answer: P3, per cycle page)
- ~3 pointing at unowned/ambiguous code (right answer: `assignee_github: null`)
Push to main; the eval runs on Person 1's machine (`npm run eval`).

### 2. Eval run + prompt iteration (owner: Person 3, 1:15–2:15)
Loop: `npm run eval` → read the misses → edit the system prompt in `src/orchestrator.js` → re-run.
Stop at 2:15 whatever the numbers are. Put the final table in README (replace the TODOs).
If dataset slips past 1:30, cut to 15 reports — a small honest table beats none.

### 3. Notion hookup (owner: Person 1, as soon as token arrives)
Token in `.env` → restart → `npm run smoke` green → test: post an AI-styling bug,
proposal should say "P3 — deferred this cycle per the cycle page."
NOTE for whoever is building the Notion page: Mamdani reads ONE page (NOTION_PAGE_ID),
top-level blocks only — headings, bullets, paragraphs. Sub-pages and databases are NOT
fetched. Make it pretty for the demo, but every rule the agent should know must be
plain text on that one page. If you use a new page instead of the draft: connect the
integration to it and update NOTION_PAGE_ID.

### 4. Demo video, ~2 min (owner: Person 1 directs, record 2:30–3:00)
Beats, pre-scripted texts, one take per beat, cuts allowed:
1. (15s) Problem: bug triage eats PM hours and misroutes bugs.
2. (30s) Clean P1: extension crash → proposal cites CODEOWNERS + commit history → `approve` → ticket in Linear, assigned.
3. (20s) Duplicate catch: paraphrase of WAR-5 → flagged with confidence.
4. (20s) Guardrails: thin report → follow-up question; `reject` path shown once.
5. (15s) Cycle awareness: AI-styling bug → P3, cites the Notion cycle page.
6. (10s) `!health` → uploads cluster flagged.
7. (10s) Eval table on screen + close.

### 5. README + submission (owner: Aiman, 3:00–3:30)
- README: team names/emails, eval numbers, demo video link, any run-instruction fixes
- Repo must be PUBLIC before submitting
- Google Form: all team emails + repo link. Submit by 3:40, not 3:59.

## Done — do not touch
Slack layer, approval flow, watcher, world data, integrations. No refactors after 2:30.
