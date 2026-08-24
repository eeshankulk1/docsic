import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, serializeFrontmatter, type Frontmatter } from "./frontmatter.js";
import { managedDir } from "./repo.js";

export const STATE_BUDGET = 800;
export const NOTE_TYPES = ["discovery", "gotcha", "decision", "idea"] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/** Fixed method so the number means the same thing everywhere: ceil(chars / 4). */
export function tokenBudget(text: string): number {
  return Math.ceil(text.length / 4);
}

export function readState(root: string): string | null {
  const p = join(managedDir(root), "state.md");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

export function writeState(root: string, text: string): { tokens: number } {
  const tokens = tokenBudget(text);
  if (tokens > STATE_BUDGET) throw new Error(`state is ${tokens} tokens; budget is ${STATE_BUDGET}. Cut it - state is a snapshot, not a log.`);
  for (const h of ["## Now", "## In flight", "## Next"]) {
    if (!text.includes(h)) throw new Error(`state must contain the section "${h}"`);
  }
  writeFileSync(join(managedDir(root), "state.md"), text.trimEnd() + "\n");
  return { tokens };
}

export interface Note { file: string; data: Frontmatter; body: string; created: Date | null }

export function listNotes(root: string): Note[] {
  const dir = join(managedDir(root), "notes");
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
  const dir = join(managedDir(root), "notes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), serializeFrontmatter(
    { title: note.title, type: note.type, status: "open", created: date }, note.body.trim() + "\n"));
  return file;
}

export function absorbNote(root: string, file: string, absorbedInto?: string): void {
  const p = join(managedDir(root), "notes", file);
  if (!existsSync(p)) throw new Error(`no note ${file}`);
  const { data, body } = parseFrontmatter(readFileSync(p, "utf8"));
  data.status = "absorbed";
  if (absorbedInto) data["absorbed-into"] = absorbedInto;
  writeFileSync(p, serializeFrontmatter(data, body));
}
