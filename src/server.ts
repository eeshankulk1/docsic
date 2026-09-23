import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { runMechanicalChecks } from "./core/check.js";
import { agentRubric, apply, triage } from "./core/init.js";
import { load } from "./core/load.js";
import { absorbNote, addNote, NOTE_TYPES, writeState } from "./core/memory.js";
import { recall } from "./core/recall.js";
import { findRepoRoot } from "./core/repo.js";
import { readConfig, writeConfig } from "./core/config.js";
import { listDocs } from "./core/docs.js";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const cwdArg = z.string().optional().describe("Any path inside the repo. Defaults to the server's cwd.");

export const AGENT_PASS_RUBRIC = `## Agent pass (mechanical checks cannot see these - judge them yourself)
- fact-ownership: the same claim asserted in two docs. One owns it, the other links.
- hub-altitude: architecture.md states a fact a leaf doc owns. Test: would a code change force an edit in both? Then the hub has the wrong copy.
- doc-vs-code: a doc claim contradicted by source. Verify claims against the files in each doc's owns:.
- plan-cited-as-truth: a plans/ file with status done|superseded referenced as current.
- doc-missing: a subsystem in code matched by no doc's owns: and with no doc.
Fix what you find; report anything you chose not to fix and why. Judgment call: the same phrase used as a property in one doc and as a blocker in another is two claims, not a duplicate.`;

export function createServer(): McpServer {
  const server = new McpServer({ name: "docsic", version: "0.1.0" });

  server.registerTool("docsic_load", {
    description: "Session-start payload: state, open notes, doc map, config summary, open queue items, and mechanical check findings for this repo. Call first in every session.",
    inputSchema: z.object({ cwd: cwdArg }),
  }, async ({ cwd }) => text(load(findRepoRoot(cwd))));

  server.registerTool("docsic_recall", {
    description: "Search docs, notes and (when a hub is configured) every other repo's knowledge. Use before solving something another session may have solved.",
    inputSchema: z.object({ query: z.string(), cwd: cwdArg, limit: z.number().int().max(50).optional() }),
  }, async ({ query, cwd, limit }) => text(recall(findRepoRoot(cwd), query, limit)));

  server.registerTool("docsic_check", {
    description: "Mechanical doc-convention checks (hub index, ownership of command-grade facts, frontmatter, links, staleness, state budget, stale notes) plus the rubric for the agent pass. Run on load and before claiming a task done; fix what it reports.",
    inputSchema: z.object({ cwd: cwdArg, agentPass: z.boolean().optional().describe("Include the agent-pass rubric and the doc bundle to judge (default true)") }),
  }, async ({ cwd, agentPass }) => {
    const root = findRepoRoot(cwd);
    const findings = runMechanicalChecks(root);
    const out: Record<string, unknown> = { findings, summary: `${findings.filter(f => f.severity === "error").length} errors, ${findings.filter(f => f.severity === "warning").length} warnings` };
    if (agentPass !== false) {
      out.agentPass = AGENT_PASS_RUBRIC;
      out.docs = listDocs(root).filter(d => d.kind === "hub" || d.kind === "narrative").map(d => ({ path: `docs/${d.rel}`, owns: d.data.owns, status: d.data.status, body: d.body }));
    }
    return text(out);
  });

  server.registerTool("docsic_init", {
    description: "Initialize a repo: triage loose markdown and payloads into docs/plans and docs/reference (history preserved, nothing deleted), scaffold docs/architecture.md, docs/docsic.json and AGENTS.md, then return the rubric for writing the docs and the defect list. Call with apply=false first to preview the triage table; confirm with the user; call again with apply=true.",
    inputSchema: z.object({ cwd: cwdArg, apply: z.boolean().default(false), projectName: z.string().optional() }),
  }, async ({ cwd, apply: doApply, projectName }) => {
    const root = findRepoRoot(cwd);
    const t = triage(root);
    if (!doApply) return text({ preview: true, triage: t, wouldCreate: ["docs/architecture.md", "docs/docsic.json", "AGENTS.md"], next: "Show the user one summary table and get one confirmation, then call docsic_init with apply=true. Work on a branch; the branch is the undo." });
    const r = apply(root, t, { projectName });
    return text({ applied: r, flagged: t.flagged, rubric: agentRubric(root, t, r) });
  });

  server.registerTool("docsic_save", {
    description: "Write memory. kind=state replaces the whole state snapshot (sections ## Now / ## In flight / ## Next, budget 800 tokens). kind=note files a discovery|gotcha|decision|idea (body <= 10 lines). kind=absorb marks a note absorbed once its content reached a permanent home. kind=config merges command-grade facts into docs/docsic.json.",
    inputSchema: z.object({
      cwd: cwdArg,
      kind: z.enum(["state", "note", "absorb", "config"]),
      content: z.string().optional().describe("state: full state text. note: body. absorb: note filename. config: JSON object to deep-merge"),
      title: z.string().optional().describe("note only"),
      type: z.enum(NOTE_TYPES).optional().describe("note only"),
      absorbedInto: z.string().optional().describe("absorb only: where the content now lives"),
    }),
  }, async ({ cwd, kind, content, title, type, absorbedInto }) => {
    const root = findRepoRoot(cwd);
    if (kind === "state") return text(writeState(root, content ?? ""));
    if (kind === "note") return text({ file: addNote(root, { title: title ?? "untitled", type: type ?? "discovery", body: content ?? "" }) });
    if (kind === "absorb") { absorbNote(root, content ?? "", absorbedInto); return text({ absorbed: content }); }
    const cfg = readConfig(root) ?? { updated: "", stacks: [] };
    const patch = JSON.parse(content ?? "{}");
    writeConfig(root, deepMerge(cfg, patch));
    return text({ config: "docs/docsic.json", merged: Object.keys(patch) });
  });

  return server;
}

function deepMerge(a: any, b: any): any {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object" || !a || !b) return b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = k in a ? deepMerge(a[k], b[k]) : b[k];
  return out;
}
