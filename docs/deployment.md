---
owns: [package.json]
status: current
---

# Deployment

docsic ships as an npm package; there is no server to deploy. Publishing runs the build and pushes `dist/` (the `files` allowlist). The package is scoped until a final name is chosen - see the naming note in [spec.md](spec.md).

## Publishing a release

1. Bump `version` in `package.json` and `package-lock.json` in the release PR; merge it.
2. From an up-to-date `main`: the `publish` command in the `release` block of [docsic.json](docsic.json) (browser 2FA). The `prepack` script runs the build first, so the tarball always holds a fresh `dist/`.
3. Check what went out: run the `verify` command in the same block, unpack the tarball, and grep `package/dist` for the release's new command or config key.

`dist/` is gitignored and was once built only by hand: 0.4.0 and 0.5.0 went out holding the 0.3.2 build (no `docsic sweep`), because each publish packed a `dist/` left over from an older checkout. 0.5.1 is the first release with the note sweep and `sweep: carry` in it.

## What init writes on a user's machine

| Harness | Registration | Hooks |
|---------|--------------|-------|
| Claude Code | `mcpServers.docsic` in the user-level config | SessionStart, UserPromptSubmit, Stop, SessionEnd in user settings |
| Codex | `[mcp_servers.docsic]` in the user config | none |
| Cursor | `mcpServers.docsic` in the user MCP config | none |

Registrations use the absolute path of the installed CLI. A first-use marker in the managed root makes registration run once; `--reinstall` repeats it.
