import "dotenv/config";

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

export const config = {
  anthropicKey: req("ANTHROPIC_API_KEY"),
  slackToken: req("SLACK_BOT_TOKEN"),
  slackChannel: req("SLACK_CHANNEL_ID"),
  linearKey: req("LINEAR_API_KEY"),
  linearTeamKey: req("LINEAR_TEAM_KEY"),
  githubToken: req("GITHUB_TOKEN"),
  githubRepo: req("GITHUB_REPO"),
  githubBranch: process.env.GITHUB_BRANCH || "main",
  userMap: JSON.parse(process.env.USER_MAP || "{}"),
  escalateAfterMin: Number(process.env.ESCALATE_AFTER_MIN || 120),
  watchIntervalSec: Number(process.env.WATCH_INTERVAL_SEC || 60),
  heatThreshold: Number(process.env.HEAT_THRESHOLD || 4),
  requireApproval: (process.env.REQUIRE_APPROVAL || "true") === "true",
  // Optional: Notion handbook access. When unset, the Notion tools are disabled.
  notionKey: process.env.NOTION_API_KEY || null,
  // Optional PM routing: {"label": "SLACK_MEMBER_ID", "default": ["id", ...]}.
  // When set, proposals mention the responsible PM and only PMs can approve.
  pmMap: process.env.PM_MAP ? JSON.parse(process.env.PM_MAP) : null,
  model: "claude-sonnet-5",
};
