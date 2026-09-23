#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMechanicalChecks } from "./core/check.js";
import { detect, register } from "./core/harness.js";
import { agentRubric, apply, triage } from "./core/init.js";
import { load } from "./core/load.js";
import { recall } from "./core/recall.js";
import { readUserConfig, userConfigPath } from "./core/hub.js";
import { findRepoRoot, managedDir, managedRoot } from "./core/repo.js";
import { distill, hook } from "./hooks.js";
import { readSettings, writeSettings } from "./core/settings.js";

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith("--")));
const args = rest.filter(a => !a.startsWith("--"));

const HELP = `docsic - keeps a codebase legible to coding agents

  npx docsic init [--yes]    register with every coding agent on this machine, then initialize this repo
  docsic check [--json]      mechanical checks (exit 1 on errors; use in CI for a hard gate)
  docsic load                the session-start payload, as JSON
  docsic recall <query>      search docs, notes, hub (--hub: every hub project only)
  docsic config [key value]  user config at ~/.docsic/config.json (hub, distill)
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
    case "recall": console.log(JSON.stringify(recall(root, args.join(" "), { hubOnly: flags.has("--hub") }), null, 2)); return;
    case "settings": {
      if (args.length === 2) console.log(JSON.stringify(writeSettings(root, { [args[0]]: args[1] } as any), null, 2));
      else console.log(JSON.stringify(readSettings(root), null, 2));
      return;
    }
    case "hook": return hook(args[0], root);
    case "distill": return distill(args[0]);
    case "config": {
      // docsic config                 -> print ~/.docsic/config.json
      // docsic config <key> <json>    -> set a top-level key (hub, distill)
      const cfg: any = readUserConfig();
      if (args.length === 2) {
        let v: unknown; try { v = JSON.parse(args[1]); } catch { v = args[1]; }
        cfg[args[0]] = v;
        mkdirSync(managedRoot(), { recursive: true });
        writeFileSync(userConfigPath(), JSON.stringify(cfg, null, 2) + "\n");
      }
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }
    default: console.log(HELP);
  }
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
