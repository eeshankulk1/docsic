export type Frontmatter = Record<string, string | string[]>;

/** Minimal YAML subset: `key: value`, `key: [a, b]`, and `key:` followed by `- item` lines. */
export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  if (!text.startsWith("---")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: text };
  const raw = text.slice(3, end).trim().split("\n");
  const body = text.slice(end + 4).replace(/^\n/, "");
  const data: Frontmatter = {};
  let listKey: string | null = null;
  for (const line of raw) {
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) {
      (data[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === "") { data[key] = []; listKey = key; continue; }
    listKey = null;
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value.slice(1, -1).split(",").map(s => unquote(s.trim())).filter(Boolean);
    } else {
      data[key] = unquote(value.replace(/\s+#.*$/, ""));
    }
  }
  return { data, body };
}

export function serializeFrontmatter(data: Frontmatter, body: string): string {
  const lines = Object.entries(data).map(([k, v]) =>
    Array.isArray(v) ? `${k}: [${v.join(", ")}]` : `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\n+/, "")}`;
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}
