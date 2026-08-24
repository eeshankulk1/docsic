import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { CONFIG, HUB, listDocs } from "./docs.js";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.js";
import { writeConfig, readConfig } from "./config.js";
import { git } from "./repo.js";

export interface Move { from: string; to: string; kind: "plan" | "reference"; date: string; note: string }
export interface Triage {
  moves: Move[];
  readmeIsArchitecture: boolean;
  flagged: string[];
  ambiguous: string[];
  existingDocs: string[];
}

const PLAN_NAME = /(_|-|^)(SUMMARY|COMPLETE|IMPLEMENTATION|DESIGN|REFACTOR|FIX|PLAN|HANDOFF|AUDIT|MIGRATION|CHANGELOG_\w+|NOTES?)\w*\.md$/i;
const OTHER_TOOL_DIRS = [".kiro", ".cursor", ".windsurf", ".github/copilot", ".aider", ".continue"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "venv", ".venv", "target", "coverage", "docs", "vendor", "Pods", "DerivedData"]);
const KNOWN_JSON = new Set(["package.json", "package-lock.json", "tsconfig.json", "composer.json", "app.json", "vercel.json", "biome.json", "eslint.config.json", ".eslintrc.json", "renovate.json", "manifest.json"]);

function firstCommitDate(root: string, rel: string): string {
  const out = git(root, ["log", "--diff-filter=A", "--follow", "--format=%cs", "--", rel]);
  const lines = out.split("\n").filter(Boolean);
  return lines[lines.length - 1] || new Date().toISOString().slice(0, 10);
}

function slugify(name: string): string {
  return name.replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function triage(root: string): Triage {
  const t: Triage = { moves: [], readmeIsArchitecture: false, flagged: [], ambiguous: [], existingDocs: listDocs(root).map(d => `docs/${d.rel}`) };
  for (const d of OTHER_TOOL_DIRS) if (existsSync(join(root, d))) t.flagged.push(`${d}/ - another tool's artifacts, left untouched`);

  const walk = (dir: string, depth: number) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(root, abs);
      let st; try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith(".") || depth >= 3) continue;
        walk(abs, depth + 1); continue;
      }
      if (name.endsWith(".md")) {
        if (/^README\.md$/i.test(name)) {
          if (rel === "README.md") { const text = readFileSync(abs, "utf8"); t.readmeIsArchitecture = looksLikeArchitecture(text); }
          continue; // nested READMEs describe their own directory
        }
        if (/^(AGENTS|CLAUDE|CONTRIBUTING|LICENSE|CHANGELOG|CODE_OF_CONDUCT|SECURITY)\.md$/i.test(name) && rel === name) continue;
        const text = readFileSync(abs, "utf8");
        if (PLAN_NAME.test(name) || depth >= 1) {
          const date = firstCommitDate(root, rel);
          t.moves.push({ from: rel, to: `docs/plans/${date}-${slugify(name)}.md`, kind: "plan", date, note: PLAN_NAME.test(name) ? "agent-artifact name pattern" : "loose markdown outside docs/" });
        } else if (fenceRatio(text) > 0.7) {
          t.moves.push({ from: rel, to: `docs/reference/${slugify(name)}.md`, kind: "reference", date: firstCommitDate(root, rel), note: "mostly verbatim code/payload" });
        } else {
          t.ambiguous.push(rel);
        }
        continue;
      }
      if (depth === 0 && name.endsWith(".json") && !KNOWN_JSON.has(name) && st.size > 2048) {
        t.moves.push({ from: rel, to: `docs/reference/${name}`, kind: "reference", date: firstCommitDate(root, rel), note: `root-level ${Math.round(st.size / 1024)}KB json - likely a captured payload` });
      }
    }
  };
  walk(root, 0);
  return t;
}

function fenceRatio(text: string): number {
  const lines = text.split("\n"); let inFence = false, fenced = 0;
  for (const l of lines) { if (/^\s*```/.test(l)) { inFence = !inFence; fenced++; continue; } if (inFence) fenced++; }
  return lines.length ? fenced / lines.length : 0;
}

function looksLikeArchitecture(text: string): boolean {
  const lines = text.split("\n").length;
  return lines > 150 && /^#+\s*(architecture|database schema|schema|data model|tables)/im.test(text);
}

export interface ApplyResult { moved: string[]; created: string[]; skipped: string[] }

/** Applies a triage plan on the current branch. Nothing is deleted; moves keep git history. */
export function apply(root: string, t: Triage, opts: { projectName?: string } = {}): ApplyResult {
  const r: ApplyResult = { moved: [], created: [], skipped: [] };
  const docs = join(root, "docs");
  for (const sub of ["", "plans", "reference"]) mkdirSync(join(docs, sub), { recursive: true });

  for (const m of t.moves) {
    const from = join(root, m.from), to = join(root, m.to);
    if (!existsSync(from) || existsSync(to)) { r.skipped.push(m.from); continue; }
    if (git(root, ["ls-files", "--error-unmatch", m.from]) === "" && !git(root, ["ls-files", m.from])) {
      // untracked: plain rename
      writeFileSync(to, readFileSync(from)); git(root, ["rm", "-q", "--cached", m.from]);
    } else {
      git(root, ["mv", m.from, m.to]);
    }
    if (m.to.endsWith(".md")) {
      const { data, body } = parseFrontmatter(readFileSync(to, "utf8"));
      const fm = m.kind === "plan"
        ? { status: "done", date: m.date, "original-path": m.from, ...data }
        : { kind: "capture", "captured-from": m.from, date: m.date, ...data };
      writeFileSync(to, serializeFrontmatter(fm, body));
    }
    r.moved.push(`${m.from} -> ${m.to}`);
  }

  const name = opts.projectName || basename(root);
  const hubPath = join(docs, HUB);
  if (!existsSync(hubPath)) {
    writeFileSync(hubPath, hubTemplate(name, t));
    r.created.push(`docs/${HUB}`);
  }
  if (!readConfig(root)) {
    writeConfig(root, { updated: "", stacks: [], notes: "" });
    r.created.push(`docs/${CONFIG}`);
  }
  const agents = join(root, "AGENTS.md");
  if (!existsSync(agents)) {
    writeFileSync(agents, agentsTemplate(name));
    r.created.push("AGENTS.md");
  }
  const claude = join(root, "CLAUDE.md");
  if (!existsSync(claude)) {
    try { symlinkSync("AGENTS.md", claude); r.created.push("CLAUDE.md -> AGENTS.md"); } catch { /* fs without symlinks */ }
  }
  return r;
}

function hubTemplate(name: string, t: Triage): string {
  const rows = [
    "| [local-dev.md](local-dev.md) | Clone-to-running narrative, prerequisites, gotchas |",
    "| [deployment.md](deployment.md) | Deploy targets, build, prod environment, CI/CD |",
  ];
  if (t.moves.some(m => m.kind === "plan")) rows.push("| [plans/](plans/) | Dated one-off artifacts: plans, runbooks, audits. `status: done` means history, not truth |");
  if (t.moves.some(m => m.kind === "reference")) rows.push("| [reference/](reference/) | Captured payloads and snapshots. Point-in-time, never a live contract |");
  return `---
owns: [.]
status: current
---

# ${name} - Architecture

<!-- Hub. States what exists and how it relates. Never states a fact a leaf doc owns. -->

## What this is

TODO

## Repo layout

TODO

## Stack

TODO

## Docs index

| Doc | Owns |
|-----|------|
${rows.join("\n")}

Exact commands, ports, env var names and service URLs live in [ctx.json](ctx.json), not in prose.
`;
}

function agentsTemplate(name: string): string {
  return `# ${name}

Start at \`docs/architecture.md\` - it indexes every doc. Exact commands, ports and env vars are in \`docs/ctx.json\`; never copy them here.

## Gotchas

<!-- Only things that fit no doc. No commands. -->
`;
}

/** What the calling agent does after apply(): the server has no model (spec §9). */
export function agentRubric(root: string, t: Triage, r: ApplyResult): string {
  return `## Your job now (ctx has no model - this part is yours)

1. Fill docs/ctx.json with every command-grade fact you can verify by reading the repo: test/build commands per stack, dev server command + port, env var names (not values), service URLs, model IDs. Run each command once; record only what works.
2. Write docs/architecture.md (hub: what exists and how it relates; index every doc), docs/local-dev.md and docs/deployment.md. Add api.md / frontend.md / data-flow.md / worker.md / ios.md only if the project has that surface. Each doc gets frontmatter: owns: [globs of the code it describes], status: current. No ports, commands, env var names or URLs in prose - point at ctx.json.
${t.readmeIsArchitecture ? "3. README.md is an architecture document. Move its substance into docs/architecture.md and rewrite README.md as a real README: what it is, a pointer to docs/, nothing version-volatile.\n" : ""}${t.ambiguous.length ? `4. Decide these ambiguous markdown files (listed, not moved): ${t.ambiguous.join(", ")}. Each becomes a plan (status: done), a reference, part of a doc, or stays.\n` : ""}
5. While writing, keep a DEFECT LIST: every claim you tried to verify and found false or broken - dead test config, hardcoded values, artifacts committed by mistake, READMEs describing a stack the project no longer uses. Report it verbatim at the end; it is the most valuable output of init.
6. Run ctx_check and fix every finding. Then ctx_save state (## Now / ## In flight / ## Next, under 800 tokens).

Work is on the current branch; review the diff before committing. Nothing was deleted.`;
}
