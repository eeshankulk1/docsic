# docsic

Keeps a codebase legible to coding agents, and keeps that legibility true as the code changes. For anyone running Claude Code, Codex or Cursor on a real repo; one command to start: `npx @eeshkulk/docsic init`.

## What it does

- Registers an MCP server with every coding agent on the machine, so each session starts with the project's state, open notes and doc map
- Initializes a repo: loose agent-written markdown becomes dated history, captured payloads get filed, and a `docs/` tree with a real index is scaffolded
- Checks the docs against the code, and gates each PR on the docs its change owns
- Keeps project memory (state, notes, decisions) outside the repo, optionally in one hub across all your projects
- Distills each session into that memory when it ends (opt-in)

Docs are for people and live in your repo. Everything else is for the agent and lives outside it.

## Surfaces and stack

- CLI and stdio MCP server: TypeScript on Node, published to npm

## Docs

Start at [docs/architecture.md](docs/architecture.md); then [local-dev.md](docs/local-dev.md) and [deployment.md](docs/deployment.md). [docs/spec.md](docs/spec.md) is the full design.
