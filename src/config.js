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
  userMap: JSON.parse(process.env.USER_MAP || "{}"),
  escalateAfterMin: Number(process.env.ESCALATE_AFTER_MIN || 120),
  watchIntervalSec: Number(process.env.WATCH_INTERVAL_SEC || 60),
  heatThreshold: Number(process.env.HEAT_THRESHOLD || 4),
  requireApproval: (process.env.REQUIRE_APPROVAL || "true") === "true",
  model: "claude-sonnet-5",
};
