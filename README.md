# docsic

docsic keeps a codebase readable for coding agents. It checks a repo's docs mechanically (`check`) and fails a PR whose code changes touch files a doc owns unless that doc is edited or waived with a reason (`gate`). It also gives each session its project memory at startup (`load`), searches docs, notes and the cross-project hub (`recall`), and runs as an MCP server for agents (`serve`). Finally, it sweeps open notes, with an agent deciding whether to absorb, cover, renew or retire each one, and ships the absorbed content as a docs-only PR (`sweep`).

Works with Claude Code, Codex and Cursor. One command to start: `npx @eeshkulk/docsic init`.

## What it does

- Registers an MCP server with every coding agent on the machine, so each session starts with the project's state, open notes and doc map
- Initializes a repo: loose agent-written markdown becomes dated history, captured payloads get filed, and a `docs/` tree with a real index is scaffolded
- Checks the docs against the code, and gates each PR on the docs its change owns
- Keeps project memory (state, notes, decisions) outside the repo, optionally in one hub across all your projects
- Distills each session into that memory when it ends (opt-in)
- Sweeps open notes into the docs that own them, archiving the rest with a reason, so the open set stays short (opt-in)

Docs are for people and live in your repo. Everything else is for the agent and lives outside it.

## Surfaces and stack

- CLI and stdio MCP server: TypeScript on Node, published to npm

## Docs

Start at [docs/architecture.md](docs/architecture.md); then [local-dev.md](docs/local-dev.md) and [deployment.md](docs/deployment.md). [docs/spec.md](docs/spec.md) is the full design.
