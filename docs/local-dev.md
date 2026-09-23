---
owns: [package.json, tsconfig.json, test/**]
status: current
---

# Local development

Node 20+ and git are the only prerequisites. Commands are in [docsic.json](docsic.json).

## Loop

Install, build, test. The build emits `dist/`, which is what the `docsic` bin and every harness registration point at, so rebuild before exercising hooks or a registered server.

## Exercising the tools without a harness

The CLI mirrors each tool: `load`, `check`, `recall`, `init`. Point them at another repo by running from inside it; the managed store is resolved from that repo's remote. Point the store override (named in docsic.json) at a scratch directory to keep experiments out of your real store.

## Hooks

`init` installs two Claude Code hooks: SessionStart prints the load payload as context, SessionStart also records HEAD for the session; Stop runs the mechanical checks and blocks once per session, but only on errors in files changed since that HEAD (committed, staged, unstaged or untracked), so pre-existing debt never blocks an unrelated session. Both read the hook payload from stdin and stay silent in repos with no `docs/docsic.json` (or pre-rename `docs/ctx.json`), i.e. anywhere `init` never ran. Re-run `init --reinstall` after changing the hook commands.

## Gotchas

- Tests create real git repos in the OS temp dir and redirect the managed store per test; they never touch your real store.
- `doc-staleness` compares commit timestamps, so an uncommitted doc edit does not clear the warning until committed.
