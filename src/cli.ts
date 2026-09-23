#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMechanicalChecks } from "./core/check.js";
import { detect, register } from "./core/harness.js";
import { agentRubric, apply, triage } from "./core/init.js";
import { load } from "./core/load.js";
import { recall } from "./core/recall.js";
import { configPath } from "./core/config.js";
import { findRepoRoot, git, managedDir, managedRoot } from "./core/repo.js";
import { readSettings, writeSettings } from "./core/settings.js";

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith("--")));
const args = rest.filter(a => !a.startsWith("--"));

const HELP = `docsic - keeps a codebase legible to coding agents

  npx docsic init [--yes]    register with every coding agent on this machine, then initialize this repo
  docsic check [--json]      mechanical checks (exit 1 on errors; use in CI for a hard gate)
  docsic load                the session-start payload, as JSON
  docsic recall <query>      search docs, notes, hub
  docsic serve               run the MCP server over stdio
`;

async function main(): Promise<void> {
  const root = findRepoRoot();
  switch (cmd) {
    case "serve": {
      const { createServer } = await import("./server.js");
      const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
      await serveStdio(() => createServer());
      return;
    }
    case "init": {
      // First-use install: register with every harness once, marked in the managed root.
      const marker = join(managedRoot(), "installed.json");
      const harnesses = detect();
      if (!existsSync(marker) || flags.has("--reinstall")) {
        const reports = harnesses.map(register);
        for (const r of reports) console.log(`registered with ${r.harness} (${r.detail})${r.hooks ? " + hooks" : ""}`);
        if (!reports.length) console.log("no MCP harness detected; add `docsic serve` as a stdio MCP server manually");
        writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), harnesses }, null, 2));
      }
      writeSettings(root, { harness: harnesses[0] ?? "mcp" });

      const t = triage(root);
      console.log(`\nrepo: ${root}\nmanaged: ${managedDir(root)}\n`);
      if (t.existingDocs.length) console.log(`existing docs/: ${t.existingDocs.length} files (kept)`);
      if (t.moves.length) {
        console.log("moves (history preserved, nothing deleted):");
        for (const m of t.moves) console.log(`  ${m.from}  ->  ${m.to}   [${m.note}]`);
      }
      if (t.readmeIsArchitecture) console.log("README.md reads as an architecture doc - the agent will move its substance into docs/architecture.md");
      for (const f of t.flagged) console.log(`flagged: ${f}`);
      for (const a of t.ambiguous) console.log(`ambiguous (not moved): ${a}`);
      if (!flags.has("--yes")) {
        console.log(`\nwould create: ${["docs/architecture.md", "docs/docsic.json", "AGENTS.md", "CLAUDE.md -> AGENTS.md"].filter(f => !existsSync(join(root, f.split(" ")[0]))).join(", ") || "nothing"}`);
        console.log("re-run with --yes to apply, on a branch (the branch is the undo).");
        return;
      }
      const r = apply(root, t);
      for (const m of r.moved) console.log(`moved   ${m}`);
      for (const c of r.created) console.log(`created ${c}`);
      const findings = runMechanicalChecks(root);
      if (findings.length) console.log(`\ndocsic check: ${findings.length} findings on the existing docs (run \`docsic check\` for the list)`);
      console.log("\n" + agentRubric(root, t, r));
      return;
    }
    case "check": {
      const f = runMechanicalChecks(root);
      if (flags.has("--json")) console.log(JSON.stringify(f, null, 2));
      else for (const x of f) console.log(`${x.severity === "error" ? "E" : "W"} ${x.rule}  ${x.file}${x.line ? ":" + x.line : ""}  ${x.message}`);
      const errors = f.filter(x => x.severity === "error").length;
      if (!flags.has("--json")) console.log(`\n${errors} errors, ${f.length - errors} warnings`);
      process.exitCode = errors ? 1 : 0;
      return;
    }
    case "load": console.log(JSON.stringify(load(root), null, 2)); return;
    case "recall": console.log(JSON.stringify(recall(root, args.join(" ")), null, 2)); return;
    case "settings": {
      if (args.length === 2) console.log(JSON.stringify(writeSettings(root, { [args[0]]: args[1] } as any), null, 2));
      else console.log(JSON.stringify(readSettings(root), null, 2));
      return;
    }
    case "hook": return hook(args[0], root);
    default: console.log(HELP);
  }
}

/** Claude Code hook entry points. stdin carries the hook payload; stdout goes back to the harness. */
async function hook(event: string, root: string): Promise<void> {
  const input = await new Promise<string>(res => { let s = ""; process.stdin.on("data", c => (s += c)); process.stdin.on("end", () => res(s)); process.stdin.resume(); });
  let payload: any = {}; try { payload = JSON.parse(input); } catch { /* empty */ }
  const cwd = payload.cwd ? findRepoRoot(payload.cwd) : root;
  if (!existsSync(configPath(cwd))) return; // `docsic init` never ran here: stay silent
  const marker = join(managedDir(cwd), `session-${payload.session_id ?? "x"}`);
  if (event === "session-start") {
    writeFileSync(marker, git(cwd, ["rev-parse", "HEAD"]));
    const p = load(cwd);
    const out = [
      "[docsic] session context",
      p.state ? `## State\n${p.state.trim()}` : "## State\n(none yet - docsic_save state before you stop)",
      p.notes.length ? `## Open notes\n${p.notes.map(n => `- (${n.type}) ${n.title}: ${n.body}`).join("\n")}` : "",
      `## Docs\n${p.docs.map(d => `- ${d.path}${d.status && d.status !== "current" ? ` [${d.status}]` : ""}`).join("\n")}`,
      p.queue.length ? `## Queue\n${p.queue.slice(0, 10).map(q => `- #${q.id} ${q.title}`).join("\n")}` : "",
      p.findings.length ? `## docsic_check\n${p.findings.map(f => `- ${f.rule} ${f.file}: ${f.message}`).join("\n")}` : "",
      p.instructions,
    ].filter(Boolean).join("\n\n");
    console.log(out);
    return;
  }
  if (event === "stop") {
    if (payload.stop_hook_active) return; // never loop
    // Gate only on files this session touched: pre-existing debt is surfaced at
    // session start, not blamed on a session that never went near it.
    const touched = changedSince(cwd, existsSync(marker) ? readFileSync(marker, "utf8").trim() : "");
    const errors = runMechanicalChecks(cwd).filter(f => f.severity === "error" && touched.has(f.file));
    if (!errors.length) return;
    const gate = join(managedDir(cwd), `gate-${payload.session_id ?? "x"}`);
    if (existsSync(gate)) return; // one nudge per session
    writeFileSync(gate, "");
    console.log(JSON.stringify({ decision: "block", reason: `docsic_check has ${errors.length} error(s). Fix them or say why not:\n` + errors.slice(0, 15).map(e => `- ${e.rule} ${e.file}${e.line ? ":" + e.line : ""}: ${e.message}`).join("\n") }));
  }
}

/** Files changed since `base` (committed, staged, unstaged or untracked), relative to the repo root. */
function changedSince(root: string, base: string): Set<string> {
  const lines = [
    base ? git(root, ["diff", "--name-only", base]) : git(root, ["diff", "--name-only", "HEAD"]),
    git(root, ["ls-files", "--others", "--exclude-standard"]),
  ].join("\n");
  return new Set(lines.split("\n").filter(Boolean));
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
