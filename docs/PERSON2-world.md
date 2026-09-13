# Person 2 (Arina) — External apps + the mock company

You own Linear and GitHub, and the company the demo lives in. **Decision from the brainstorm: the mock company is Aiman's deployed AI wardrobe app** — a real repo and a real product, with your team playing its engineering org and bugs coming from an internal QA team. The API clients already exist (`src/linear.js`, `src/github.js`); your job is to make the wardrobe repo and a Linear workspace tell a consistent story, and deliver working keys.

Run `npm run smoke` after each step — it tests each integration independently and pinpoints what's broken.

## Step 0 — World spec from the real app (20 min, with Aiman)
Sit with Aiman for 10 minutes and map the wardrobe repo into components. Write the result into `docs/WORLD.md`:

| Component | Real repo paths | Fictional team lead (real GitHub account) |
|---|---|---|
| auth / accounts | e.g. `src/auth/`, `app/login/` | teammate A |
| wardrobe / closet core | e.g. `src/closet/` | teammate B |
| AI recommendations | e.g. `src/recs/` | teammate C |
| uploads / images | e.g. `src/upload/` | teammate A |

Use the ACTUAL paths from the repo — the agent searches real code. Spread ownership across all three of you even though Aiman wrote it; CODEOWNERS is the ownership policy and that's what makes assignment evidence-based. Person 3 needs this table for eval ground truth.

## Step 1 — Prepare the wardrobe repo (30 min — needs Aiman's push access)
1. Repo must be readable by the API token. **Public is strongly preferred** — GitHub code search indexes public repos and works with any token. If it must stay private, the token needs repo read access AND code search may not work → tell Person 1 early so they swap in the tree-listing fallback.
2. Add `.github/CODEOWNERS` matching the WORLD.md table exactly:
   ```
   /src/auth/    @teammate-a
   /src/closet/  @teammate-b
   /src/recs/    @teammate-c
   ```
   (real paths, real GitHub usernames — Aiman commits this)
3. Optional but nice (15 min): 2–3 commits per teammate on "their" paths so commit history corroborates CODEOWNERS. Author email must be the account's `USERNAME@users.noreply.github.com` for GitHub to link the commit to the login.
4. Verify searchability now — indexing lags on fresh changes:
   ```bash
   npm run smoke
   ```
   Also sanity-check that terms QA would use in bug reports ("upload", "outfit", "login", "recommendation") actually appear in the code.

**Exit:** smoke shows GitHub: repo ✓, CODEOWNERS ✓, code search returns hits.

## Step 2 — Linear workspace (30 min)
1. Create a free Linear workspace; note the team key (e.g. `WRD`) → `LINEAR_TEAM_KEY`.
2. Invite both teammates — their Linear emails must match what you put in `USER_MAP`.
3. Personal API key: Settings → Security & access → API keys → `LINEAR_API_KEY`.
4. Seed ~10 issues as if the QA team has been filing for weeks, all about the wardrobe app. Must include:
   - **The duplicate target**: e.g. `Auth fails on WebKit — session token refresh 401s` (note its identifier, tell Person 3 — the demo's paraphrased report must collide with it)
   - a mix of priorities and labels matching WORLD.md components (`auth`, `closet`, `recs`, `uploads`), some assigned, 2–3 completed
   - 3–4 open issues this week with the same label (e.g. `uploads`) — feeds the component-health ping demo

**Exit:** smoke shows Linear: team ✓, issues ✓, users ✓, USER_MAP entries all resolve.

## Step 3 — Keys handoff (10 min)
Fill Person 1's `.env` (DM the values, never commit):
- `GITHUB_TOKEN` — fine-grained PAT with read access to the wardrobe repo
- `GITHUB_REPO=aiman-account/wardrobe-repo-name`
- `LINEAR_API_KEY`, `LINEAR_TEAM_KEY`
- `USER_MAP={"teammate-a":"a@email.com","teammate-b":"b@email.com","teammate-c":"c@email.com"}` — GitHub login → Linear email. Wrong mapping = every assignment silently falls back to the triage queue.

**Exit:** `npm run smoke` fully green on Person 1's machine.

## Step 4 — Eval ground truth (with Person 3)
Rewrite `eval/reports.json` so every report is about the wardrobe app and every `expected` field (severity, assignee login, duplicate identifier) is true in YOUR Linear workspace and YOUR CODEOWNERS. Placeholder values from the scaffold (`priya-gh`, `ENG-12`) must all be gone.

**Exit:** `npm run eval` failures are agent mistakes, not world mismatches.
