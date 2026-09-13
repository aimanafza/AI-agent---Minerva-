import { config } from "./config.js";

async function gh(path, params = {}) {
  const url = new URL(`https://api.github.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const EXCLUDED_DIRS = ["node_modules/", ".git/", "dist/", "build/"];
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
]);

function isExcludedPath(path) {
  if (EXCLUDED_DIRS.some((d) => path.startsWith(d) || path.includes(`/${d}`))) return true;
  const filename = path.split("/").pop();
  return LOCKFILE_NAMES.has(filename) || filename.endsWith(".lock");
}

// Full recursive file tree for the configured branch, fetched once per process.
let treePromise = null;
export async function getTree() {
  if (!treePromise) {
    treePromise = (async () => {
      const data = await gh(`/repos/${config.githubRepo}/git/trees/${config.githubBranch}`, { recursive: 1 });
      return (data.tree || [])
        .filter((it) => it.type === "blob")
        .map((it) => it.path)
        .filter((p) => !isExcludedPath(p));
    })();
  }
  return treePromise;
}

function tokenize(query) {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

// Find files in the repo whose PATH matches words from the query (a component
// or feature name, e.g. "avatar", "upload", "waitlist") — not full-text search.
export async function findFiles(query) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];

  const tree = await getTree();
  const scored = [];
  for (const path of tree) {
    const lower = path.toLowerCase();
    const filename = lower.slice(lower.lastIndexOf("/") + 1);
    const dirPart = lower.slice(0, lower.length - filename.length);
    let score = 0;
    for (const token of tokens) {
      if (filename.includes(token)) score += 2;
      if (dirPart.includes(token)) score += 1;
    }
    if (score > 0) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((s) => s.path);
}

// Exact-match existence check against the cached tree — used by guardrails.
export async function treeHasPath(path) {
  const tree = await getTree();
  return tree.includes(path);
}

// Fetch CODEOWNERS from the usual locations.
export async function getCodeowners() {
  for (const loc of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    try {
      const data = await gh(`/repos/${config.githubRepo}/contents/${loc}`);
      return Buffer.from(data.content, "base64").toString("utf8");
    } catch {
      // try next location
    }
  }
  return null;
}

// Recent commit authors for a path — who actually touches this code.
export async function recentCommits(path) {
  const commits = await gh(`/repos/${config.githubRepo}/commits`, {
    path,
    per_page: 10,
  });
  return commits.map((c) => ({
    login: c.author?.login || null,
    name: c.commit.author?.name,
    date: c.commit.author?.date,
    message: c.commit.message.split("\n")[0].slice(0, 80),
  }));
}
