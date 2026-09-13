// Standalone integration smoke test: checks each external app independently
// so Person 1 and Person 2 can verify their halves without running the agent.
// Usage: npm run smoke
import "dotenv/config";

const env = process.env;
let failures = 0;

function ok(label, detail = "") {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label, detail) {
  failures++;
  console.log(`  ✗ ${label} — ${detail}`);
}

console.log("\n[env]");
for (const name of [
  "ANTHROPIC_API_KEY",
  "SLACK_BOT_TOKEN",
  "SLACK_CHANNEL_ID",
  "LINEAR_API_KEY",
  "LINEAR_TEAM_KEY",
  "GITHUB_TOKEN",
  "GITHUB_REPO",
  "USER_MAP",
]) {
  env[name] ? ok(name) : fail(name, "missing from .env");
}

console.log("\n[slack]");
if (env.SLACK_BOT_TOKEN) {
  try {
    const auth = await slackApi("auth.test", {});
    ok("auth", `bot ${auth.user} in ${auth.team}`);
    if (env.SLACK_CHANNEL_ID) {
      const info = await slackApi("conversations.info", { channel: env.SLACK_CHANNEL_ID });
      ok("channel", `#${info.channel.name}`);
      info.channel.is_member
        ? ok("bot is in channel")
        : fail("bot is in channel", "run /invite @your-bot in the channel");
    }
  } catch (e) {
    fail("slack", e.message);
  }
} else {
  console.log("  (skipped — no token)");
}

console.log("\n[linear]");
if (env.LINEAR_API_KEY) {
  try {
    const teams = await linearGql(
      `query($key: String!) { teams(filter: {key: {eq: $key}}) { nodes { id key name } } }`,
      { key: env.LINEAR_TEAM_KEY || "" }
    );
    teams.teams.nodes.length
      ? ok("team", `${teams.teams.nodes[0].key} (${teams.teams.nodes[0].name})`)
      : fail("team", `no team with key '${env.LINEAR_TEAM_KEY}'`);
    const issues = await linearGql(`query { issues(first: 100) { nodes { identifier } } }`);
    const n = issues.issues.nodes.length;
    n >= 5 ? ok("issues", `${n} found`) : fail("issues", `only ${n} — seed ~10 (see docs/PERSON2-world.md step 2)`);
    const users = await linearGql(`query { users { nodes { name email } } }`);
    ok("users", users.users.nodes.map((u) => `${u.name}<${u.email}>`).join(", "));
    if (env.USER_MAP) {
      const map = JSON.parse(env.USER_MAP);
      const emails = new Set(users.users.nodes.map((u) => u.email?.toLowerCase()));
      for (const [gh, email] of Object.entries(map)) {
        emails.has(email.toLowerCase())
          ? ok(`USER_MAP ${gh}`, email)
          : fail(`USER_MAP ${gh}`, `${email} is not a Linear user in this workspace`);
      }
    }
  } catch (e) {
    fail("linear", e.message);
  }
} else {
  console.log("  (skipped — no key)");
}

console.log("\n[github]");
if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
  try {
    const repo = await gh(`/repos/${env.GITHUB_REPO}`);
    ok("repo", repo.full_name);
    let owners = null;
    for (const loc of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
      try {
        owners = await gh(`/repos/${env.GITHUB_REPO}/contents/${loc}`);
        ok("CODEOWNERS", loc);
        break;
      } catch {}
    }
    if (!owners) fail("CODEOWNERS", "not found — add .github/CODEOWNERS");
    const search = await gh(`/search/code?q=${encodeURIComponent(`login repo:${env.GITHUB_REPO}`)}`);
    search.total_count > 0
      ? ok("code search", `${search.total_count} hits for 'login'`)
      : fail("code search", "0 hits — repo may not be indexed yet; retry in 15 min, else tell Person 1 (tree fallback)");
    const commits = await gh(`/repos/${env.GITHUB_REPO}/commits?per_page=10`);
    const logins = [...new Set(commits.map((c) => c.author?.login).filter(Boolean))];
    logins.length >= 2
      ? ok("commit authors", logins.join(", "))
      : fail("commit authors", `only [${logins.join(", ")}] link to GitHub accounts — check author noreply emails (docs/PERSON2-world.md step 1.4)`);
  } catch (e) {
    fail("github", e.message);
  }
} else {
  console.log("  (skipped — no token/repo)");
}

console.log(failures ? `\n${failures} FAILURE(S) — see above\n` : "\nALL GREEN — ready for end-to-end\n");
process.exit(failures ? 1 : 0);

// --- minimal clients (standalone on purpose: runs even when src/config.js would throw) ---
async function slackApi(method, params) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.error}`);
  return data;
}
async function linearGql(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: env.LINEAR_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors[0]?.message || data.errors));
  return data.data;
}
async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}
