#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMechanicalChecks } from "./core/check.js";
import { detect, register } from "./core/harness.js";
import { agentRubric, apply, triage } from "./core/init.js";
import { load } from "./core/load.js";
import { recall } from "./core/recall.js";
import { findRepoRoot, managedDir, managedRoot } from "./core/repo.js";
import { readSettings, writeSettings } from "./core/settings.js";

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith("--")));
const args = rest.filter(a => !a.startsWith("--"));

const HELP = `ctx - keeps a codebase legible to coding agents

  npx ctx init [--yes]    register with every coding agent on this machine, then initialize this repo
  ctx check [--json]      mechanical checks (exit 1 on errors; use in CI for a hard gate)
  ctx load                the session-start payload, as JSON
  ctx recall <query>      search docs, notes, hub
  ctx serve               run the MCP server over stdio
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
        if (!reports.length) console.log("no MCP harness detected; add `ctx serve` as a stdio MCP server manually");
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
      if (!flags.has("--yes") && t.moves.length) {
        console.log("\nre-run with --yes to apply, on a branch (the branch is the undo).");
        return;
      }
      const r = apply(root, t);
      for (const m of r.moved) console.log(`moved   ${m}`);
      for (const c of r.created) console.log(`created ${c}`);
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
  if (!existsSync(join(cwd, "docs"))) return; // not a ctx repo: stay silent
  if (event === "session-start") {
    const p = load(cwd);
    const out = [
      "[ctx] session context",
      p.state ? `## State\n${p.state.trim()}` : "## State\n(none yet - ctx_save state before you stop)",
      p.notes.length ? `## Open notes\n${p.notes.map(n => `- (${n.type}) ${n.title}: ${n.body}`).join("\n")}` : "",
      `## Docs\n${p.docs.map(d => `- ${d.path}${d.status && d.status !== "current" ? ` [${d.status}]` : ""}`).join("\n")}`,
      p.queue.length ? `## Queue\n${p.queue.slice(0, 10).map(q => `- #${q.id} ${q.title}`).join("\n")}` : "",
      p.findings.length ? `## ctx_check\n${p.findings.map(f => `- ${f.rule} ${f.file}: ${f.message}`).join("\n")}` : "",
      p.instructions,
    ].filter(Boolean).join("\n\n");
    console.log(out);
    return;
  }
  if (event === "stop") {
    if (payload.stop_hook_active) return; // never loop
    const errors = runMechanicalChecks(cwd).filter(f => f.severity === "error");
    if (!errors.length) return;
    const gate = join(managedDir(cwd), `gate-${payload.session_id ?? "x"}`);
    if (existsSync(gate)) return; // one nudge per session
    writeFileSync(gate, "");
    console.log(JSON.stringify({ decision: "block", reason: `ctx_check has ${errors.length} error(s). Fix them or say why not:\n` + errors.slice(0, 15).map(e => `- ${e.rule} ${e.file}${e.line ? ":" + e.line : ""}: ${e.message}`).join("\n") }));
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
