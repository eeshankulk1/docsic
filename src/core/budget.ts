/**
 * Token budgets for what hooks inject. Memory grows forever (decision rows,
 * open notes); the session-start payload must not. Everything past a budget
 * stays on disk and in recall - only the injected index is bounded.
 */

/** Fixed method so the number means the same thing everywhere: ceil(chars / 4). */
export function tokenBudget(text: string): number {
  return Math.ceil(text.length / 4);
}

export const DECISIONS_BUDGET = 600;
export const NOTES_BUDGET = 400;
export const STALE_NOTE_DAYS = 30;

/**
 * Characters one hook may print. Claude Code saves hook output over 10,000
 * characters to a file and shows the model a 2 KB preview, so a longer payload
 * loses everything after its first screen. The margin keeps clear of that line.
 */
export const HOOK_LIMIT = 9_800;

/** A piece of a hook's output. `more` says where the rest is if it gets cut; a block without one is short and fixed. */
export interface Block { text: string; more?: string }

const SEP = "\n\n";
const cutNote = (b: Block) => (b.more ? `[cut to fit: the rest is in ${b.more}]` : "");
const cutLines = (text: string, n: number) => text.slice(0, Math.max(0, text.lastIndexOf("\n", n)));

/**
 * Joins blocks given in order of worth under `limit`. Each takes what is left,
 * cut at a line end, and a cut block says where the rest is. Room for those
 * lines is held back up front, so every block keeps at least its pointer.
 */
export function fitPayload(blocks: Block[], limit = HOOK_LIMIT): string {
  const kept = blocks.filter(b => b.text);
  let room = limit - kept.reduce((n, b) => n + cutNote(b).length + SEP.length, 0);
  const out: string[] = [];
  for (const b of kept) {
    const note = cutNote(b);
    room += note.length + SEP.length;
    const text = b.text.length + SEP.length <= room ? b.text : [cutLines(b.text, room - note.length - SEP.length - 1), note].filter(Boolean).join("\n");
    if (text) out.push(text);
    room -= text.length + SEP.length;
  }
  const all = out.join(SEP);
  return all.length <= limit ? all : cutLines(all, limit); // only when there are too many blocks for even their pointers
}

/** Several payloads in one hook's output: the smallest go first, so a short one leaves its share to the long ones. */
export function fitGroups(groups: Block[][], limit = HOOK_LIMIT): string {
  const size = (g: Block[]) => g.reduce((n, b) => n + b.text.length, 0);
  const smallFirst = groups.map((_, i) => i).sort((a, b) => size(groups[a]) - size(groups[b]));
  const out: string[] = [];
  let left = limit;
  smallFirst.forEach((g, i) => {
    out[g] = fitPayload(groups[g], Math.floor(left / (smallFirst.length - i)));
    left -= out[g].length + SEP.length;
  });
  return out.filter(Boolean).join(SEP);
}

/** Items in order until their rendered lines would pass `budget` tokens; the first always fits. */
export function takeWithin<T>(items: T[], budget: number, line: (t: T) => string): { lines: string[]; shown: T[]; rest: T[] } {
  const lines: string[] = [];
  let used = 0;
  let i = 0;
  for (; i < items.length; i++) {
    const l = line(items[i]);
    const cost = tokenBudget(l + "\n");
    if (i > 0 && used + cost > budget) break;
    lines.push(l);
    used += cost;
  }
  return { lines, shown: items.slice(0, i), rest: items.slice(i) };
}

const TYPE_RANK: Record<string, number> = { gotcha: 0, decision: 1, discovery: 2, idea: 3 };

/** A note's creation date: its `created` frontmatter, else the YYYY-MM-DD filename prefix. */
export function noteDate(n: { file: string; created?: string | null }): string {
  return (n.created ?? "").slice(0, 10) || n.file.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
}

/** Injection order: pinned notes, then gotcha > decision > discovery > idea, newest first within a type. */
export function orderNotes<T extends { file: string; type: string; created?: string | null; pinned?: boolean }>(notes: T[]): T[] {
  return [...notes].sort((a, b) =>
    Number(!!b.pinned) - Number(!!a.pinned) ||
    (TYPE_RANK[a.type] ?? 4) - (TYPE_RANK[b.type] ?? 4) || noteDate(b).localeCompare(noteDate(a)) || b.file.localeCompare(a.file));
}

export function staleCount(notes: { file: string; created?: string | null }[], now = Date.now()): number {
  const cutoff = new Date(now - STALE_NOTE_DAYS * 86_400_000).toISOString().slice(0, 10);
  return notes.filter(n => { const d = noteDate(n); return !!d && d < cutoff; }).length;
}

/** The trailing line for notes that didn't fit, or null when everything was shown. */
export function moreNotesLine(rest: { file: string; created?: string | null }[], where: string): string | null {
  if (!rest.length) return null;
  const stale = staleCount(rest);
  return `+${rest.length} more open note${rest.length > 1 ? "s" : ""}${stale ? ` (${stale} open ${STALE_NOTE_DAYS}+ days)` : ""} in ${where} - triage them: absorb each into its home or drop it`;
}
