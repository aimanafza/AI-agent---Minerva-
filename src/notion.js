import { config } from "./config.js";

export function notionEnabled() {
  return Boolean(config.notionKey && config.notionPageId);
}

// Fetch the cycle-priorities page as plain text (headings/bullets preserved).
export async function getCyclePriorities() {
  const res = await fetch(
    `https://api.notion.com/v1/blocks/${config.notionPageId}/children?page_size=100`,
    {
      headers: {
        Authorization: `Bearer ${config.notionKey}`,
        "Notion-Version": "2022-06-28",
      },
    }
  );
  if (!res.ok) throw new Error(`Notion API ${res.status}: ${await res.text()}`);
  const data = await res.json();

  const lines = [];
  for (const block of data.results || []) {
    const t = block.type;
    const rich = block[t]?.rich_text;
    if (!rich) continue;
    const text = rich.map((r) => r.plain_text).join("");
    if (!text.trim()) continue;
    if (t.startsWith("heading")) lines.push(`\n## ${text}`);
    else if (t === "bulleted_list_item" || t === "numbered_list_item") lines.push(`- ${text}`);
    else if (t === "to_do") lines.push(`- [${block.to_do?.checked ? "x" : " "}] ${text}`);
    else lines.push(text);
  }
  return lines.join("\n").trim() || "Cycle page is empty.";
}
