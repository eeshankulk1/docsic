import { readConfig } from "./config.js";
import { listDocs } from "./docs.js";
import { listNotes, readState, STATE_BUDGET } from "./memory.js";
import { git, managedDir, repoIdentity } from "./repo.js";
import { readSettings } from "./settings.js";
import { tracker } from "./tracker.js";
import { runMechanicalChecks, type Finding } from "./check.js";

export interface LoadPayload {
  repo: { root: string; identity: string; branch: string; managed: string };
  state: string | null;
  notes: { file: string; title: string; type: string; body: string }[];
  docs: { path: string; kind: string; status?: string; owns?: string[] }[];
  config: { present: boolean; stacks: string[]; notes?: string };
  queue: { id: string; title: string; url: string }[];
  findings: Finding[];
  instructions: string;
}

export function load(root: string): LoadPayload {
  const settings = readSettings(root);
  const docs = listDocs(root);
  const cfg = readConfig(root);
  const notes = listNotes(root).filter(n => n.data.status === "open");
  const findings = runMechanicalChecks(root);
  const hasHooks = settings.harness === "claude-code" || settings.harness === "codex";
  return {
    repo: { root, identity: repoIdentity(root), branch: git(root, ["branch", "--show-current"]), managed: managedDir(root) },
    state: readState(root),
    notes: notes.map(n => ({ file: n.file, title: String(n.data.title ?? n.file), type: String(n.data.type ?? "discovery"), body: n.body.trim() })),
    docs: docs.filter(d => d.kind !== "config").map(d => ({
      path: `docs/${d.rel}`, kind: d.kind,
      ...(d.data.status ? { status: String(d.data.status) } : {}),
      ...(Array.isArray(d.data.owns) ? { owns: d.data.owns } : {}),
    })),
    config: { present: !!cfg, stacks: cfg?.stacks?.map(s => s.name) ?? [], ...(cfg?.notes ? { notes: cfg.notes } : {}) },
    queue: settings.tracker === "none" ? [] : tracker(root, settings).listOpen(),
    findings,
    instructions: [
      docs.length ? "Start at docs/architecture.md; it indexes every doc. Exact commands, ports and env vars are in docs/ctx.json - never in prose." : "No docs/ yet. Run ctx_init.",
      "Plans with status done|superseded and docs with status superseded are history, not current truth.",
      `Before claiming a task done: run ctx_check and fix what it reports, then ctx_save state (budget ${STATE_BUDGET} tokens, sections ## Now / ## In flight / ## Next).`,
      hasHooks ? "" : "This harness has no session-end hook: ctx_save is the only way state gets written. Do it before you stop.",
      "Learned something the hard way that fits no doc? ctx_save a note. Absorb notes once their content reaches a permanent home.",
    ].filter(Boolean).join("\n"),
  };
}
