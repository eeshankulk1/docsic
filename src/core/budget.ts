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

/** Injection order: gotcha > decision > discovery > idea, newest first within a type. */
export function orderNotes<T extends { file: string; type: string; created?: string | null }>(notes: T[]): T[] {
  return [...notes].sort((a, b) =>
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
