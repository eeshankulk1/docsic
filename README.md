# ctx

Keeps a codebase legible to coding agents, and keeps that legibility true as the code changes.

One command: `npx @eesh/ctx init`. It registers an MCP server with every coding agent on your machine, then initializes the repo: loose agent-written markdown becomes dated history, captured payloads get filed, and a `docs/` tree with a real index is scaffolded. From then on every session loads state, checks the docs against the code, and repairs drift before claiming work done.

Docs are for people and live in your repo. Everything else is for the agent and lives outside it.

Read [docs/architecture.md](docs/architecture.md) to start; [docs/spec.md](docs/spec.md) is the full design.
