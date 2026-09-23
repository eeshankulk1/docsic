---
owns: [package.json]
status: current
---

# Deployment

docsic ships as an npm package; there is no server to deploy. Publishing runs the build and pushes `dist/` (the `files` allowlist). The package is scoped until a final name is chosen - see the naming note in [spec.md](spec.md).

## What init writes on a user's machine

| Harness | Registration | Hooks |
|---------|--------------|-------|
| Claude Code | `mcpServers.docsic` in the user-level config | SessionStart, UserPromptSubmit, Stop, SessionEnd in user settings |
| Codex | `[mcp_servers.docsic]` in the user config | none |
| Cursor | `mcpServers.docsic` in the user MCP config | none |

Registrations use the absolute path of the installed CLI. A first-use marker in the managed root makes registration run once; `--reinstall` repeats it.
