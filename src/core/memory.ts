import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "./frontmatter.js";
import { loadHub, projectDir, resolveScope, syncHub, type Hub } from "./hub.js";
import { managedDir } from "./repo.js";

export const STATE_BUDGET = 800;
export const NOTE_TYPES = ["discovery", "gotcha", "decision", "idea"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/** Fixed method so the number means the same thing everywhere: ceil(chars / 4). */
export function tokenBudget(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Where a repo's state and notes live: its hub project folder when a hub is
 * configured and the repo maps to one, else the local store. Runtime files
 * (settings, session markers) always stay in the local store.
 */
export function memoryHome(root: string): { dir: string; hub: Hub | null; slug: string | null } {
  const hub = loadHub();
  const scope = hub ? resolveScope(root, hub) : null;
  if (hub && scope?.kind === "project") return { dir: projectDir(hub, scope.project.slug), hub, slug: scope.project.slug };
  return { dir: managedDir(root), hub: null, slug: null };
}

function synced(root: string, summary: string): void {
  const h = memoryHome(root);
  if (h.hub && h.slug) syncHub(h.hub, h.slug, summary);
}

export function readState(root: string): string | null {
  const p = join(memoryHome(root).dir, "state.md");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function writeState(root: string, text: string): { tokens: number } {
  const tokens = tokenBudget(text);
  if (tokens > STATE_BUDGET) throw new Error(`state is ${tokens} tokens; budget is ${STATE_BUDGET}. Cut it - state is a snapshot, not a log.`);
  for (const h of ["## Now", "## In flight", "## Next"]) {
    if (!text.includes(h)) throw new Error(`state must contain the section "${h}"`);
  }
  writeFileSync(join(memoryHome(root).dir, "state.md"), text.trimEnd() + "\n");
  synced(root, "state");
  return { tokens };
}

export interface Note { file: string; data: Frontmatter; body: string; created: Date | null }

export function listNotes(root: string): Note[] {
  const dir = join(memoryHome(root).dir, "notes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".md")).sort().map(file => {
    const { data, body } = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
    const created = data.created ? new Date(String(data.created)) : null;
    return { file, data, body, created };
  });
}

export function addNote(root: string, note: { title: string; type: NoteType; body: string }): string {
  const lines = note.body.trim().split("\n");
  if (lines.length > 10) throw new Error(`note body is ${lines.length} lines; max 10. Notes are an inbox, not a shelf.`);
  const date = new Date().toISOString().slice(0, 10);
  const slug = note.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const file = `${date}-${slug}.md`;
  const dir = join(memoryHome(root).dir, "notes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), serializeFrontmatter(
    { title: note.title, type: note.type, status: "open", created: date }, note.body.trim() + "\n"));
  synced(root, `note ${slug}`);
  return file;
}

export function absorbNote(root: string, file: string, absorbedInto?: string): void {
  const p = join(memoryHome(root).dir, "notes", file);
  if (!existsSync(p)) throw new Error(`no note ${file}`);
  const { data, body } = parseFrontmatter(readFileSync(p, "utf8"));
  data.status = "absorbed";
  if (absorbedInto) data["absorbed-into"] = absorbedInto;
  writeFileSync(p, serializeFrontmatter(data, body));
  synced(root, `absorbed ${file}`);
}
