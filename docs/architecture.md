---
owns: [src/**]
status: current
---

# docsic - Architecture

A CLI + MCP server that keeps a codebase legible to coding agents and keeps that legibility true as the code changes. The full design is in [spec.md](spec.md); this doc is the map of the implementation.

## What this is

Two entry points over one core:

- `docsic serve` - stdio MCP server exposing five tools: `docsic_load`, `docsic_recall`, `docsic_init`, `docsic_check`, `docsic_save`. The interface every session uses.
- `docsic <cmd>` - the CLI. `init` registers the server with every detected harness (Claude Code, Codex, Cursor) and triages the repo; `check` is the same mechanical pass for CI; `hook` is the Claude Code hook entry.

The server has no model. Judgment work (the agent pass of `docsic_check`, the init defect list, distilling state) is returned to the calling agent as material plus a rubric.

## Repo layout

| Path | Role |
|------|------|
| `src/cli.ts` | Command dispatch and Claude Code hook handlers |
| `src/server.ts` | MCP tool registrations; the agent-pass rubric |
| `src/core/repo.ts` | Repo root, remote-URL identity, managed store location |
| `src/core/docs.ts` | Reads `docs/`, classifies files (hub, narrative, plan, reference, config) |
| `src/core/frontmatter.ts` | Minimal YAML-subset frontmatter parser and serializer |
| `src/core/check.ts` | Mechanical rules and the command-grade token detector |
| `src/core/memory.ts` | State (budgeted) and notes (open/absorbed) in the managed store |
| `src/core/config.ts` | `docs/docsic.json` read/write |
| `src/core/settings.ts` | Per-user adapter choices (managed, never in the repo) |
| `src/core/tracker.ts` | Tracker adapter: `github` via the gh CLI, `none` |
| `src/core/load.ts` | Assembles the session-start payload |
| `src/core/recall.ts` | Term search over docs, notes, and the hub directory |
| `src/core/init.ts` | Triage classification, scaffold, and the agent rubric |
| `src/core/harness.ts` | Harness detection, MCP registration, hook install |
| `test/` | Vitest suites on throwaway git repos |

## Storage

- Repo: `docs/` only, including `docs/docsic.json` for command-grade facts.
- Managed: `~/.docsic/<slug>-<hash>/` with `state.md`, `notes/`, `settings.json`. Keyed by normalized remote URL so worktrees share one store; an environment override (named in docsic.json) relocates the root.

## Docs index

| Doc | Owns |
|-----|------|
| [spec.md](spec.md) | The product specification: promise, storage model, doc set, ownership rules, tool surface, validation record |
| [local-dev.md](local-dev.md) | Clone-to-running, how to exercise the server and hooks locally |
| [deployment.md](deployment.md) | Publishing to npm and what `init` writes on a user's machine |

Exact commands live in [docsic.json](docsic.json).
