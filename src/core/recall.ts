import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { listDocs } from "./docs.js";
import { listNotes } from "./memory.js";
import { readSettings } from "./settings.js";

export interface Hit { source: string; score: number; excerpt: string }

function terms(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9_.-]+/).filter(t => t.length > 2);
}

function score(text: string, ts: string[]): number {
  const lower = text.toLowerCase();
  return ts.reduce((n, t) => n + (lower.split(t).length - 1), 0);
}

function excerpt(text: string, ts: string[], width = 240): string {
  const lower = text.toLowerCase();
  let best = 0;
  for (const t of ts) { const i = lower.indexOf(t); if (i >= 0) { best = i; break; } }
  const start = Math.max(0, best - 60);
  return text.slice(start, start + width).replace(/\s+/g, " ").trim();
}

function walkMd(dir: string, out: { path: string; text: string }[], depth = 0): void {
  if (depth > 4 || !existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walkMd(abs, out, depth + 1);
    else if (name.endsWith(".md")) out.push({ path: abs, text: readFileSync(abs, "utf8") });
  }
}

export function recall(root: string, query: string, limit = 10): Hit[] {
  const ts = terms(query);
  if (!ts.length) return [];
  const hits: Hit[] = [];
  for (const d of listDocs(root)) {
    if (d.kind === "config") continue;
    const s = score(d.raw, ts);
    if (s) hits.push({ source: `docs/${d.rel}`, score: s, excerpt: excerpt(d.body, ts) });
  }
  for (const n of listNotes(root)) {
    const s = score(n.body + " " + n.data.title, ts);
    if (s) hits.push({ source: `note:${n.file} (${n.data.status})`, score: s * 2, excerpt: n.body.trim() });
  }
  const hub = readSettings(root).hub;
  if (hub && hub !== "none" && existsSync(hub)) {
    const files: { path: string; text: string }[] = [];
    walkMd(hub, files);
    for (const f of files) {
      const s = score(f.text, ts);
      if (s) hits.push({ source: `hub:${relative(hub, f.path)}`, score: s, excerpt: excerpt(f.text, ts) });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
