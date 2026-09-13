import { config } from "./config.js";

export function notionEnabled() {
  return Boolean(config.notionKey);
}

async function notionApi(path, body = undefined, method = body ? "POST" : "GET") {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.notionKey}`,
      "Notion-Version": "2022-06-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`);
  return res.json();
}

// List pages the integration can see (i.e. the handbook teamspace pages
// whose top-level page has the integration connected).
export async function searchPages(query = "") {
  const data = await notionApi("/search", {
    query,
    filter: { property: "object", value: "page" },
    page_size: 50,
  });
  return (data.results || []).map((p) => ({
    id: p.id,
    title:
      Object.values(p.properties || {})
        .find((prop) => prop.type === "title")
        ?.title?.map((t) => t.plain_text)
        .join("") || "(untitled)",
    lastEdited: p.last_edited_time,
  }));
}

function blockText(block) {
  const rich = block[block.type]?.rich_text;
  return rich ? rich.map((r) => r.plain_text).join("") : "";
}

// Read a page's content as plain text. Recurses into nested blocks
// (toggles, columns, lists) up to `depth`; child pages are listed by
// title+id so the caller can read them with another call.
async function renderBlocks(blockId, depth, indent = "") {
  const lines = [];
  let cursor = undefined;
  do {
    const data = await notionApi(
      `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`
    );
    for (const block of data.results || []) {
      const t = block.type;
      if (t === "child_page") {
        lines.push(`${indent}[SUB-PAGE: "${block.child_page?.title}" — id: ${block.id}]`);
        continue;
      }
      if (t === "child_database") {
        lines.push(`${indent}[DATABASE: "${block.child_database?.title}" — not readable, put rules in plain text]`);
        continue;
      }
      const text = blockText(block);
      if (text.trim()) {
        if (t.startsWith("heading")) lines.push(`${indent}## ${text}`);
        else if (t === "bulleted_list_item" || t === "numbered_list_item") lines.push(`${indent}- ${text}`);
        else if (t === "to_do") lines.push(`${indent}- [${block.to_do?.checked ? "x" : " "}] ${text}`);
        else lines.push(`${indent}${text}`);
      }
      if (block.has_children && depth > 0) {
        lines.push(...(await renderBlocks(block.id, depth - 1, indent + "  ")));
      }
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return lines;
}

export async function readPage(pageId) {
  const lines = await renderBlocks(pageId, 2);
  return lines.join("\n").trim() || "(page is empty)";
}
