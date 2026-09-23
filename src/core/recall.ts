import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { listDocs } from "./docs.js";
import { listNotes } from "./memory.js";
import { loadHub, parseDecisionRows } from "./hub.js";

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

export function recall(root: string, query: string, opts: { limit?: number; hubOnly?: boolean } = {}): Hit[] {
  const ts = terms(query);
  if (!ts.length) return [];
  const hits: Hit[] = [];
  if (!opts.hubOnly) {
    for (const d of listDocs(root)) {
      if (d.kind === "config") continue;
      const s = score(d.raw, ts);
      if (s) hits.push({ source: `docs/${d.rel}`, score: s, excerpt: excerpt(d.body, ts) });
    }
    for (const n of listNotes(root)) {
      const s = score(n.body + " " + n.data.title, ts);
      if (s) hits.push({ source: `note:${n.file} (${n.data.status})`, score: s * 2, excerpt: n.body.trim() });
    }
  }
  const hub = loadHub();
  if (hub) hits.push(...hubHits(hub.root, ts, opts.hubOnly ? new Set() : new Set(listNotes(root).map(n => n.file))));
  return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 10);
}

/**
 * Everything in the hub (every project, plus whatever else lives there). Units are
 * rendered whole where a fragment would be useless: a decisions.md row, a note.
 */
function hubHits(hubRoot: string, ts: string[], skipNotes: Set<string>): Hit[] {
  const files: { path: string; text: string }[] = [];
  walkMd(hubRoot, files);
  const hits: Hit[] = [];
  for (const f of files) {
    const rel = relative(hubRoot, f.path);
    if (basename(f.path) === "decisions.md") {
      for (const r of parseDecisionRows(f.text)) {
        const s = score(`${r.decision} ${r.reasoning}`, ts);
        if (s) hits.push({ source: `hub:${rel}:${r.line}`, score: s * 2, excerpt: `${r.date} | ${r.decision} | ${r.reasoning}`.slice(0, 1200) });
      }
      continue;
    }
    if (/\/notes\//.test(f.path)) {
      if (skipNotes.has(basename(f.path))) continue; // already found as this repo's own note
      const s = score(f.text, ts);
      if (s) hits.push({ source: `hub:${rel}`, score: s * 2, excerpt: f.text.trim().slice(0, 1200) });
      continue;
    }
    const s = score(f.text, ts);
    if (s) hits.push({ source: `hub:${rel}`, score: s, excerpt: excerpt(f.text, ts) });
  }
  return hits;
}
