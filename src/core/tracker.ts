import { execFileSync } from "node:child_process";
import type { Settings } from "./settings.js";

export interface Issue { id: string; title: string; url: string }

export interface Tracker {
  listOpen(): Issue[];
  read(id: string): { title: string; body: string; url: string } | null;
  close(id: string, ref: string): boolean;
}

function gh(root: string, args: string[]): string {
  try { return execFileSync("gh", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
}

export function github(root: string): Tracker {
  return {
    listOpen() {
      const out = gh(root, ["issue", "list", "--state", "open", "--limit", "50", "--json", "number,title,url"]);
      if (!out) return [];
      return (JSON.parse(out) as { number: number; title: string; url: string }[]).map(i => ({ id: String(i.number), title: i.title, url: i.url }));
    },
    read(id) {
      const out = gh(root, ["issue", "view", id, "--json", "title,body,url"]);
      return out ? JSON.parse(out) : null;
    },
    close(id, ref) {
      return gh(root, ["issue", "close", id, "--comment", `Closed via ${ref}`]) !== "";
    },
  };
}

export const none: Tracker = { listOpen: () => [], read: () => null, close: () => false };

export function tracker(root: string, s: Settings): Tracker {
  return s.tracker === "github" ? github(root) : none;
}
