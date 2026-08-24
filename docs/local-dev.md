---
owns: [package.json, tsconfig.json, test/**]
status: current
---

# Local development

Node 20+ and git are the only prerequisites. Commands are in [ctx.json](ctx.json).

## Loop

Install, build, test. The build emits `dist/`, which is what the `ctx` bin and every harness registration point at, so rebuild before exercising hooks or a registered server.

## Exercising the tools without a harness

The CLI mirrors each tool: `load`, `check`, `recall`, `init`. Point them at another repo by running from inside it; the managed store is resolved from that repo's remote. Set `CTX_HOME` to a scratch directory to keep experiments out of your real store.

## Hooks

`init` installs two Claude Code hooks: SessionStart prints the load payload as context, Stop runs the mechanical checks and blocks once per session while errors remain. Both read the hook payload from stdin and stay silent in repos with no `docs/`. Re-run `init --reinstall` after changing the hook commands.

## Gotchas

- Tests create real git repos in the OS temp dir and set `CTX_HOME` per test; they never touch `~/.ctx`.
- `doc-staleness` compares commit timestamps, so an uncommitted doc edit does not clear the warning until committed.
