import { config } from "./config.js";

async function gql(query, variables = {}) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: config.linearKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) throw new Error(`Linear error: ${JSON.stringify(data.errors)}`);
  return data.data;
}

let teamIdCache = null;
export async function getTeamId() {
  if (teamIdCache) return teamIdCache;
  const data = await gql(
    `query($key: String!) { teams(filter: {key: {eq: $key}}) { nodes { id key } } }`,
    { key: config.linearTeamKey }
  );
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`No Linear team with key ${config.linearTeamKey}`);
  teamIdCache = team.id;
  return team.id;
}

export async function recentIssues(limit = 100) {
  const data = await gql(
    `query($n: Int!) {
      issues(first: $n, orderBy: updatedAt) {
        nodes {
          id identifier title description priority createdAt updatedAt
          state { name type }
          assignee { name email }
          labels { nodes { name } }
        }
      }
    }`,
    { n: limit }
  );
  return data.issues.nodes.map((i) => ({
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    description: (i.description || "").slice(0, 300),
    priority: i.priority, // 0 none, 1 urgent, 2 high, 3 medium, 4 low
    state: i.state?.name,
    stateType: i.state?.type,
    assignee: i.assignee?.name || null,
    labels: i.labels.nodes.map((l) => l.name),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  }));
}

let usersCache = null;
export async function getUsers() {
  if (usersCache) return usersCache;
  const data = await gql(`query { users { nodes { id name email } } }`);
  usersCache = data.users.nodes;
  return usersCache;
}

export async function findUserByEmail(email) {
  const users = await getUsers();
  return users.find((u) => u.email?.toLowerCase() === email.toLowerCase()) || null;
}

// Resolve label names to ids, creating any that don't exist yet.
export async function getOrCreateLabelIds(names) {
  if (!names?.length) return [];
  const teamId = await getTeamId();
  const data = await gql(
    `query($teamId: String!) { team(id: $teamId) { labels { nodes { id name } } } }`,
    { teamId }
  );
  const existing = new Map(data.team.labels.nodes.map((l) => [l.name.toLowerCase(), l.id]));
  const ids = [];
  for (const name of names) {
    const found = existing.get(name.toLowerCase());
    if (found) {
      ids.push(found);
      continue;
    }
    const created = await gql(
      `mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) { success issueLabel { id } }
      }`,
      { input: { name, teamId } }
    );
    if (created.issueLabelCreate.success) ids.push(created.issueLabelCreate.issueLabel.id);
  }
  return ids;
}

// severity "P0"|"P1" -> 1 (urgent), "P2" -> 2 (high), "P3" -> 3 (medium)
export function severityToPriority(sev) {
  return { P0: 1, P1: 1, P2: 2, P3: 3 }[sev] ?? 0;
}

// Approved tickets land in the Backlog workflow state; un-approved ones stay
// in Triage so the team can still reference them.
let backlogStateIdCache;
export async function getBacklogStateId() {
  if (backlogStateIdCache !== undefined) return backlogStateIdCache;
  const teamId = await getTeamId();
  const data = await gql(
    `query($teamId: String!) { team(id: $teamId) { states { nodes { id name type } } } }`,
    { teamId }
  );
  const backlog = data.team.states.nodes.find((s) => s.type === "backlog");
  backlogStateIdCache = backlog?.id || null;
  return backlogStateIdCache;
}

// Triage an EXISTING issue in place (the direct-in-Linear entry point).
export async function updateIssue({ id, severity, assigneeId, labels }) {
  const labelIds = await getOrCreateLabelIds(labels);
  const stateId = await getBacklogStateId();
  const data = await gql(
    `mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue { id identifier url }
      }
    }`,
    {
      id,
      input: {
        priority: severityToPriority(severity),
        ...(assigneeId ? { assigneeId } : {}),
        ...(labelIds.length ? { labelIds } : {}),
        ...(stateId ? { stateId } : {}),
      },
    }
  );
  if (!data.issueUpdate.success) throw new Error("Linear issueUpdate failed");
  return data.issueUpdate.issue;
}

export async function addComment(issueId, body) {
  await gql(
    `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
    { input: { issueId, body } }
  );
}

export async function createIssue({ title, description, severity, assigneeId, labels }) {
  const teamId = await getTeamId();
  const labelIds = await getOrCreateLabelIds(labels);
  const stateId = await getBacklogStateId(); // approved at creation time -> straight to Backlog
  const data = await gql(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }`,
    {
      input: {
        teamId,
        title,
        description,
        priority: severityToPriority(severity),
        ...(assigneeId ? { assigneeId } : {}),
        ...(labelIds.length ? { labelIds } : {}),
        ...(stateId ? { stateId } : {}),
      },
    }
  );
  if (!data.issueCreate.success) throw new Error("Linear issueCreate failed");
  return data.issueCreate.issue; // { identifier, url }
}
