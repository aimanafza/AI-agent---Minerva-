import { config } from "./config.js";

async function slackApi(method, params) {
  // Form-encoded: Slack's read methods (conversations.*) reject JSON bodies.
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) body.set(k, String(v));
  }
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.slackToken}` },
    body,
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`);
  return data;
}

export async function postMessage(text, thread_ts = undefined) {
  return slackApi("chat.postMessage", {
    channel: config.slackChannel,
    text,
    thread_ts,
    unfurl_links: false,
  });
}

// Poll for new channel messages since `oldest`. Returns messages oldest-first.
export async function fetchNewMessages(oldest) {
  const data = await slackApi("conversations.history", {
    channel: config.slackChannel,
    oldest,
    inclusive: false,
    limit: 20,
  });
  return (data.messages || []).reverse();
}

// Fetch replies in a thread (for follow-up answers from the reporter).
export async function fetchThread(thread_ts) {
  const data = await slackApi("conversations.replies", {
    channel: config.slackChannel,
    ts: thread_ts,
    limit: 50,
  });
  return data.messages || [];
}

// Reactions on a message (needs the reactions:read scope; caller should
// tolerate a missing_scope error until the app is reinstalled with it).
export async function getReactions(ts) {
  const data = await slackApi("reactions.get", {
    channel: config.slackChannel,
    timestamp: ts,
    full: true,
  });
  return (data.message?.reactions || []).map((r) => ({ name: r.name, users: r.users || [] }));
}

export async function getBotUserId() {
  const data = await slackApi("auth.test", {});
  return data.user_id;
}
