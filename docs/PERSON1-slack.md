# Person 1 — Slack layer (intake, replies, escalations, demo choreography)

You own everything the user sees in Slack. The plumbing already exists: `src/slack.js` (API client), `src/index.js` (poll loop + follow-up threads), the reply formatting in `src/executor.js`, and the escalation messages in `src/watcher.js`. Your job is to stand it up, harden it, and make it look great on screen.

Work top to bottom. Each step has a verifiable exit condition.

## Step 1 — Slack app (15 min)
1. Create/use a Slack workspace where you're admin.
2. https://api.slack.com/apps → Create New App → From scratch. Name: `triage-agent`.
3. OAuth & Permissions → Bot Token Scopes: `channels:history`, `channels:read`, `chat:write`.
4. Install App to Workspace. Copy the `xoxb-...` Bot User OAuth Token.
5. Create a `#bugs` channel, then `/invite @triage-agent` in it.
6. Channel ID: click the channel name → About → Channel ID (starts with `C`).

**Exit:** you have `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID`. Put them in `.env` (copy `.env.example`). Add `ANTHROPIC_API_KEY` too — you run the agent process.

## Step 2 — First heartbeat (10 min)
```bash
npm install && npm start
```
Post `hello` in #bugs. The bot must reply ":mag: On it…" in a thread. It will then error on Linear/GitHub until Person 2 delivers keys — that's expected; read the terminal, not Slack.

**Exit:** bot replies to a channel message. If not: is the bot invited to the channel? Right token? Right channel ID?

## Step 3 — Message formatting pass (45 min)
The user-facing strings live in:
- `src/executor.js` — the "Filed as ENG-482, P1, assigned to Priya" reply. Make it Slack-pretty (mrkdwn: `*bold*`, `<url|text>` links). It must read well in the demo screenshot: identifier, severity, assignee, duplicate line, ticket URL.
- `src/index.js` — the ":mag: On it…" ack and the ":question: Before I file this…" follow-up.
- `src/watcher.js` — the :rotating_light: escalation and :thermometer: component-health messages.

**Exit:** every message type looks intentional, not debug output.

## Step 4 — Follow-up thread flow (30 min)
Post a deliberately thin report: `the settings page looks slightly off`. The agent should ask ONE question in the thread (not file a ticket). Answer it in the thread ("it's the billing tab, all users, no workaround"). The agent must then file using both messages.

This path is `pendingQuestions` in `src/index.js`. Test it twice in a row; fix anything flaky (double-processing, missed replies).

**Exit:** thin report → question → answer → correct ticket, reliably.

## Step 5 — Watcher timing for the demo (15 min)
In `.env`: `ESCALATE_AFTER_MIN=2`, `WATCH_INTERVAL_SEC=30`. File a P1 (via a real report), don't assign it in Linear, wait 2 min: exactly ONE :rotating_light: escalation must appear, and it must not repeat on later sweeps.

**Exit:** one escalation, no spam.

## Step 4b — Approval flow (20 min)
With `REQUIRE_APPROVAL=true` (default), the agent posts a triage *proposal* in the thread and waits. Reply `approve` → it files and confirms. Reply `reject too vague` → it drops and acknowledges. Test both paths; this is the "PM approves" beat from the team flow, and it needs no front-end.

## Step 6 — Demo choreography (do at ~2 PM with everyone)
Script the five beats, in this order, with pre-written QA-style report texts about the wardrobe app:
1. Clean P1: report about a broken money/core flow → proposal with owner rationale → PM replies `approve` → filed and assigned.
2. Duplicate: paraphrase of the seeded ticket ("login dead on Safari" vs seeded "Auth fails on WebKit") → dupe flagged in the proposal.
3. Thin report → follow-up question → answer → proposal → approve.
4. Rejection: PM replies `reject` on one proposal — shows the human is really in control.
5. Escalation: the approved-but-unassigned P1 from beat 1 fires the :rotating_light: two minutes later (start the clock during beats 2–4 so it lands on cue).

**Exit:** you can run all four beats in under 3 wall-clock minutes, twice in a row.

## Stretch (only if all above is done)
- `reactions:write` scope + a ✅ reaction on the original report once filed.
- A `!health` command in the channel that triggers the component-heat report on demand (nice for the demo instead of waiting).
