---
owns: [package.json, tsconfig.json, test/**]
status: current
---

# Local development

Node 20+ and git are the only prerequisites. Commands are in [docsic.json](docsic.json).

## Loop

Install, build, test. The build emits `dist/`, which is what the `docsic` bin and every harness registration point at, so rebuild before exercising hooks or a registered server. Packing and publishing run the build themselves (the `prepack` script), so a tarball never holds a stale `dist/`; see [deployment.md](deployment.md).

## Exercising the tools without a harness

The CLI mirrors each tool: `load`, `check`, `recall`, `init`. Point them at another repo by running from inside it; the managed store is resolved from that repo's remote. Point the store override (named in docsic.json) at a scratch directory to keep experiments out of your real store.

`sweep` runs the note sweep by hand on the repo you run it from (or a hub project by slug). Its dry run spends a real agent run but changes nothing: the docs patch, a copy of any hub file the agent wrote, and its decisions stay in the sweep's work directory under the managed root. A limit on the number of notes keeps a first look cheap. An unknown flag or stray argument exits 2 without sweeping; `docsic sweep --help` prints the help.

## Hooks

`init` installs four Claude Code hooks: SessionStart prints the load payload (and hub memory) as context, UserPromptSubmit injects hub memory on a project's first mention, SessionEnd hands off to the distiller when `distill` is `auto` (for a rollcall worker, only once its task has finished) and starts a note sweep when `sweep` is `auto`, `pr` or `carry` and the project is due one (or has staged sweep edits to settle), SessionStart also records HEAD for the session; Stop runs the mechanical checks and blocks once per session, but only on errors in files changed since that HEAD (committed, staged, unstaged or untracked), so pre-existing debt never blocks an unrelated session. Stop also blocks once per session when staged sweep edits wait and the session's branch has work and no PR on GitHub yet, asking it to run `sweep apply` and commit them with its work; this part needs no `init`, only a carry. Both read the hook payload from stdin and stay silent in repos with no `docs/docsic.json` (or pre-rename `docs/ctx.json`), i.e. anywhere `init` never ran. Re-run `init --reinstall` after changing the hook commands.

## Gotchas

- Tests create real git repos in the OS temp dir and redirect the managed store per test; they never touch your real store.
- The sweep tests put stand-ins for the agent CLI and `gh` first on PATH, and a bare repo stands in for origin; nothing reaches a model or GitHub.
- `doc-staleness` compares commit timestamps, so an uncommitted doc edit does not clear the warning until committed.
