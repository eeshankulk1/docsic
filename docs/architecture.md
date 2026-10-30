---
owns: [src/**]
status: current
---

# docsic - Architecture

A CLI + MCP server that keeps a codebase legible to coding agents and keeps that legibility true as the code changes. The full design is in [spec.md](spec.md); this doc is the map of the implementation.

## What this is

Two entry points over one core:

- `docsic serve` - stdio MCP server exposing five tools: `docsic_load`, `docsic_recall`, `docsic_init`, `docsic_check`, `docsic_save`. The interface every session uses.
- `docsic <cmd>` - the CLI. `init` registers the server with every detected harness (Claude Code, Codex, Cursor) and triages the repo; `check` is the same mechanical pass for CI; `gate` is the per-PR docs gate (docs whose `owns:` match a change must be edited or waived); `hook` is the harness hook entry; `distill` is the background session-end distiller; `sweep` is the note sweep (`sweep apply` writes its staged edits into the current checkout); `config` edits the per-user config.

The server has no model. Judgment work (the agent pass of `docsic_check`, the init defect list) is returned to the calling agent as material plus a rubric. The exceptions live outside the server, in detached processes the session-end hook starts when the user opts in: the distiller (`distill: auto`) has a headless agent CLI turn a finished task or session into state and notes, and the note sweep (`sweep: auto`, `pr` or `carry`) has one judge the open notes while docsic does the mechanical rest (the worktree, the guard rails, the docs PR or the edits staged to ride the next PR, the archive).

## Repo layout

| Path | Role |
|------|------|
| `src/cli.ts` | Command dispatch |
| `src/hooks.ts` | Hook handlers (session start, prompt submit, stop, session end) and the distiller |
| `src/core/agent.ts` | Finds and runs the headless agent CLI (Claude Code, else Codex) for the distiller and the sweep |
| `src/core/sweep.ts` | The note sweep: trigger, worktree, agent prompt, guard rails on its edits, the docs PR or the carry (edits staged for the next PR, the Stop hook's ask, `sweep apply`, settling once they land), outcomes into the archive, the state line |
| `src/core/rollcall.ts` | What the optional rollcall coordinator knows about a session: the task a worker works on, the projects a supervisor has open tasks in |
| `src/server.ts` | MCP tool registrations; the agent-pass rubric |
| `src/core/repo.ts` | Repo root, remote-URL identity, managed store location |
| `src/core/docs.ts` | Reads `docs/`, classifies files (hub, narrative, plan, reference, config) |
| `src/core/frontmatter.ts` | Minimal YAML-subset frontmatter parser and serializer |
| `src/core/check.ts` | Mechanical rules and the command-grade token detector |
| `src/core/gate.ts` | The PR docs gate: changed files since the merge base -> required docs -> edited, waived or missing; unowned code; the advisory README cadence check |
| `src/core/memory.ts` | State (budgeted) and notes (open, renewed, pinned, or archived with an outcome), in the hub project folder or the managed store |
| `src/core/hub.ts` | Optional hub: per-user config, project routing, memory rendering, git sync |
| `src/core/budget.ts` | Token measure and injection budgets: what hooks inject from growing lists (decision rows, open notes) stays bounded, and all a hook prints stays under Claude Code's 10,000 character line |
| `src/core/config.ts` | `docs/docsic.json` read/write |
| `src/core/settings.ts` | Per-user adapter choices (managed, never in the repo) |
| `src/core/tracker.ts` | Tracker adapter: `github` via the gh CLI, `none` |
| `src/core/load.ts` | Assembles the session-start payload |
| `src/core/recall.ts` | Term search over docs, notes, the note archive, and every hub project (decision rows and notes rendered whole) |
| `src/core/init.ts` | Triage classification, scaffold, and the agent rubric |
| `src/core/harness.ts` | Harness detection, MCP registration, hook install |
| `test/` | Vitest suites on throwaway git repos |

## Storage

- Repo: `docs/` only, including `docs/docsic.json` for command-grade facts.
- Managed: `~/.docsic/<slug>-<hash>/` with `state.md`, `notes/` (and `notes/archive/` for notes that left the open set), `settings.json`. Keyed by normalized remote URL so worktrees share one store; an environment override (named in docsic.json) relocates the root. `~/.docsic/config.json` is the per-user config (hub, distill, sweep); `~/.docsic/sessions/` holds per-session hook markers (head at start, the once-per-session Stop asks, whether the session is a supervisor), the distiller's logs and locks, and what it already captured (`distilled-<session>`: transcript size; `distill-task-<home>-<id>-<stateAt>`: one empty file per finish); `~/.docsic/sweeps/` holds each project's sweep marker, lock, log, carry (`<key>.carry.json`: staged edits as a patch, with their notes and the branch that took them) and work directory (the notes handed to the agent, its decisions, the repo worktree while it runs).
- Hub (optional): a git repo with `projects/<slug>/` folders. When the config names one and a repo maps to a project (path segment equals the slug, an alias, or `<slug>-*`), that folder replaces the managed store for state and notes, writes are committed and pushed in the background, and the hooks add workspace-wide memory: a one-line-per-project snapshot outside any project, a project's memory on its first mention in a prompt (state, plus decision and open-note indexes held to a token budget), and deltas written by parallel sessions.

## Docs index

| Doc | Owns |
|-----|------|
| [spec.md](spec.md) | The product specification: promise, storage model, doc set, ownership rules, tool surface, validation record |
| [local-dev.md](local-dev.md) | Clone-to-running, how to exercise the server and hooks locally |
| [deployment.md](deployment.md) | Publishing to npm and what `init` writes on a user's machine |
| [plans/](plans/) | Dated plans with a lifecycle; `done` and `superseded` ones are history |

Exact commands live in [docsic.json](docsic.json); the PR gate's config (`ignore`, `owns`, the `readme` cadence) is [gate.json](gate.json).
