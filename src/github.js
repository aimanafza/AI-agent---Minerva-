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

// Search code in the demo repo for a term (error message, component name, route).
export async function searchCode(query) {
  const data = await gh("/search/code", { q: `${query} repo:${config.githubRepo}` });
  return (data.items || []).slice(0, 8).map((it) => ({
    path: it.path,
    name: it.name,
  }));
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
