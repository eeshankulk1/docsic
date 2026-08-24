import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseFrontmatter, type Frontmatter } from "./frontmatter.js";
import { docsDir } from "./repo.js";

export interface Doc {
  /** path relative to docs/, e.g. "api.md" or "plans/2026-01-01-x.md" */
  rel: string;
  abs: string;
  kind: "hub" | "narrative" | "plan" | "reference" | "config" | "other";
  data: Frontmatter;
  body: string;
  raw: string;
}

export const HUB = "architecture.md";
export const CONFIG = "ctx.json";

export function listDocs(root: string): Doc[] {
  const dir = docsDir(root);
  if (!existsSync(dir)) return [];
  const out: Doc[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      const rel = relative(dir, abs);
      const raw = readFileSync(abs, "utf8");
      const isMd = name.endsWith(".md");
      const { data, body } = isMd ? parseFrontmatter(raw) : { data: {}, body: raw };
      let kind: Doc["kind"] = "other";
      if (rel === HUB) kind = "hub";
      else if (rel === CONFIG) kind = "config";
      else if (rel.startsWith("plans/") && isMd) kind = "plan";
      else if (rel.startsWith("reference/")) kind = "reference";
      else if (isMd && !rel.includes("/")) kind = "narrative";
      out.push({ rel, abs, kind, data, body, raw });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Every relative link target inside a markdown body. */
export function mdLinks(body: string): { target: string; line: number }[] {
  const links: { target: string; line: number }[] = [];
  body.split("\n").forEach((l, i) => {
    for (const m of l.matchAll(/\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const t = m[1];
      if (/^[a-z]+:/i.test(t)) continue;
      links.push({ target: t, line: i + 1 });
    }
  });
  return links;
}

/** Targets the hub index references, normalized to docs-relative paths (dirs keep trailing slash). */
export function hubIndexTargets(hub: Doc): Set<string> {
  const set = new Set<string>();
  for (const { target } of mdLinks(hub.body)) set.add(target.replace(/^\.\//, ""));
  // bare backticked references: any .md, plus the two lifecycle dirs
  for (const m of hub.body.matchAll(/`([\w./-]+\.md|plans\/|reference\/)`/g)) set.add(m[1]);
  return set;
}
