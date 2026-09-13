# Person 2 — External apps + the fictional company

You own Linear, GitHub, and the fake company the demo lives in. The API clients already exist (`src/linear.js`, `src/github.js`) — your job is to build the WORLD they read from, and deliver working keys. The agent's owner-attribution trick (CODEOWNERS + commit history) is only as convincing as the repo you build here.

Run `npm run smoke` after each step — it tests each integration independently and tells you exactly what's still broken.

## Step 0 — The fictional company (15 min, with Person 3)
Suggested, take it and move on: **Fernwood** — team expense-tracking SaaS.
- Components → repo paths → owners (use your team's two REAL GitHub accounts):
  | Component | Paths | Owner |
  |---|---|---|
  | auth | `src/auth/` | account A |
  | billing/checkout | `src/billing/` | account B |
  | reports UI | `src/reports/` | account A |
  | API core | `src/api/` | account B |
- Write this table into `docs/WORLD.md` — Person 3 needs it for eval ground truth.

## Step 1 — GitHub demo repo (60 min, the important one)
1. Create a **public** repo (public = code search works with any token), e.g. `fernwood-app`.
2. Seed plausible code. Fastest: generate small real-looking files yourself (an auth module with a `refreshToken` function, a billing module with `calculateTotal`, a reports page, etc.). It needs to be searchable, not runnable. 15–20 files across the four paths. Include distinctive strings a bug report would mention: "checkout", "login", "token refresh", "export report".
3. `.github/CODEOWNERS`:
   ```
   /src/auth/     @account-a
   /src/reports/  @account-a
   /src/billing/  @account-b
   /src/api/      @account-b
   ```
4. **Commit history from both accounts.** The agent attributes ownership via commit authors, and GitHub links a commit to an account by AUTHOR EMAIL. For each batch of commits set:
   ```bash
   git config user.name "Account A" 
   git config user.email "ACCOUNT-A-USERNAME@users.noreply.github.com"
   ```
   (the noreply email always matches). ~5 commits per person on their own paths, real-sounding messages ("fix token refresh retry on 401", "handle discounted items in cart total").
5. **Test code search NOW, not later** — GitHub takes a while to index new repos:
   ```bash
   npm run smoke
   ```
   If code search stays empty >30 min after pushing, tell Person 1 — there is a planned fallback (swap the search tool for a repo-tree listing).

**Exit:** smoke shows GitHub: repo ✓, CODEOWNERS ✓, code search returns hits for "login".

## Step 2 — Linear workspace (30 min)
1. Create a free Linear workspace, note the team key (e.g. `ENG`) → `LINEAR_TEAM_KEY`.
2. Invite both teammates (their Linear account emails must appear in `USER_MAP`).
3. Personal API key: Settings → Security & access → API keys → `LINEAR_API_KEY`.
4. Seed ~10 issues matching `docs/WORLD.md`. Must include:
   - `Auth fails on WebKit — token refresh 401s` (THE duplicate target; remember its identifier, e.g. ENG-12, and tell Person 3)
   - a mix of priorities, labels (`auth`, `billing`, `reports`, `api`), some assigned, 2–3 completed
   - 3+ open issues labeled `billing` created this week (feeds the component-health demo)

**Exit:** smoke shows Linear: team ✓, N issues ✓, users listed.

## Step 3 — Keys handoff (10 min)
Fill in Person 1's `.env` (send values over DM, never commit):
- `GITHUB_TOKEN` — fine-grained PAT, read-only on the demo repo (public repo: "Public Repositories" access is enough)
- `GITHUB_REPO=your-org/fernwood-app`
- `LINEAR_API_KEY`, `LINEAR_TEAM_KEY`
- `USER_MAP={"account-a":"a@email.com","account-b":"b@email.com"}` — GitHub login → Linear account email. If this mapping is wrong, every assignment silently falls back to the triage queue.

**Exit:** `npm run smoke` fully green on Person 1's machine.

## Step 4 — Update eval ground truth (with Person 3)
Go through `eval/reports.json` and replace the placeholder logins (`priya-gh`, `aiman-gh`) and duplicate ids (`ENG-12`) with the real ones from your world. Every `expected` field must be true IN YOUR WORKSPACE, or the eval numbers lie.

**Exit:** Person 3 can run `npm run eval` and the failures are agent failures, not world mismatches.
