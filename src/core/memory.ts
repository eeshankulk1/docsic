import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokenBudget } from "./budget.js";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "./frontmatter.js";
import { loadHub, projectDir, resolveScope, syncHub, type Hub } from "./hub.js";
import { managedDir } from "./repo.js";

export { tokenBudget };
export const STATE_BUDGET = 800;
export const NOTE_TYPES = ["discovery", "gotcha", "decision", "idea"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
/** How a note left the open set. Renewed notes stay open, so they are not here. */
export const OUTCOMES = ["absorbed", "covered", "retired"] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** notes/archive/: every note that left the open set, with its outcome and reason. Nothing is deleted. */
export const ARCHIVE = "archive";

export const today = (): string => new Date().toISOString().slice(0, 10);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

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

function readNotes(dir: string): Note[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith(".md")).sort().map(file => {
    const { data, body } = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
    const created = data.created ? new Date(String(data.created)) : null;
    return { file, data, body, created };
  });
}

/** Notes in a memory directory's notes/ (open, plus any absorbed before the archive existed). */
export function notesIn(dir: string): Note[] {
  return readNotes(join(dir, "notes"));
}

/** Notes that left the open set, in notes/archive/. */
export function archiveIn(dir: string): Note[] {
  return readNotes(join(dir, "notes", ARCHIVE));
}

export function listNotes(root: string): Note[] {
  return notesIn(memoryHome(root).dir);
}

export function listArchive(root: string): Note[] {
  return archiveIn(memoryHome(root).dir);
}

export function addNote(root: string, note: { title: string; type: NoteType; body: string }): string {
  const lines = note.body.trim().split("\n");
  if (lines.length > 10) throw new Error(`note body is ${lines.length} lines; max 10. Notes are an inbox, not a shelf.`);
  const date = today();
  const slug = note.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const file = `${date}-${slug}.md`;
  const dir = join(memoryHome(root).dir, "notes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), serializeFrontmatter(
    { title: note.title, type: note.type, status: "open", created: date }, note.body.trim() + "\n"));
  synced(root, `note ${slug}`);
  return file;
}

function rewrite(path: string, change: (data: Frontmatter) => void): void {
  const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
  change(data);
  writeFileSync(path, serializeFrontmatter(data, body));
}

function notePath(dir: string, file: string): string {
  const p = join(dir, "notes", file);
  if (!existsSync(p)) throw new Error(`no note ${file}`);
  return p;
}

/**
 * Move a note out of the open set into notes/archive/. Its title, type, date
 * and body stay as they were; the frontmatter gains the outcome, the date it
 * left, the reason, and where its content now lives. Returns the archive path
 * relative to the memory directory.
 */
export function archiveNoteIn(dir: string, file: string, r: { outcome: Outcome; reason?: string; into?: string; date?: string }): string {
  const src = notePath(dir, file);
  rewrite(src, data => {
    const into = r.into ?? data["absorbed-into"]; // a note absorbed before the archive existed
    delete data["absorbed-into"];
    delete data.pinned;
    data.status = "archived";
    data.outcome = r.outcome;
    data.archived = r.date ?? today();
    if (into) data.into = oneLine(String(into));
    if (r.reason) data.reason = oneLine(r.reason);
  });
  mkdirSync(join(dir, "notes", ARCHIVE), { recursive: true });
  let name = file;
  for (let i = 2; existsSync(join(dir, "notes", ARCHIVE, name)); i++) name = file.replace(/\.md$/, `-${i}.md`);
  renameSync(src, join(dir, "notes", ARCHIVE, name));
  return `notes/${ARCHIVE}/${name}`;
}

/** Keep a note open on evidence that it is still true and in use; a pinned note is injected first, and a renewal without `pin` unpins it. */
export function renewNoteIn(dir: string, file: string, r: { evidence: string; pin?: boolean; date?: string }): void {
  rewrite(notePath(dir, file), data => {
    const d = r.date ?? today();
    data.renewed = d;
    data.swept = d;
    data.evidence = oneLine(r.evidence);
    if (r.pin) data.pinned = "true";
    else delete data.pinned;
  });
}

/** Record that a sweep looked at a note and left it open (its home was unclear, or its absorb did not land). */
export function markSweptIn(dir: string, file: string, date = today()): void {
  rewrite(notePath(dir, file), data => { data.swept = date; });
}

/** A session absorbed a note (or found it covered, or wrong): it moves to the archive with that outcome. */
export function absorbNote(root: string, file: string, absorbedInto?: string, r: { outcome?: Outcome; reason?: string } = {}): string {
  const rel = archiveNoteIn(memoryHome(root).dir, file, { outcome: r.outcome ?? "absorbed", into: absorbedInto, reason: r.reason });
  synced(root, `${r.outcome ?? "absorbed"} ${file}`);
  return rel;
}
