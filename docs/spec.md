---
owns: [src/**]
status: current
---

<!-- docsic: allow command-grade -->

# docsic - Specification v1

> Working name. The system keeps a codebase legible to coding agents, and keeps that legibility true as the code changes.

Status: draft, 2026-08-23. Derived from the docs-standard v2 rollout across throu/trvld/sideline/shopir-ai and a full cold-start migration of Cordinate-App (1,123 files, 33 scattered markdown files, no structure).

---

## 1. The promise

One command, ever:

```
npx docsic init
```

Run it in a repo. On first use it installs itself and registers with every coding agent on the machine that supports MCP - Claude Code, Codex, Cursor, whatever is there - then initializes the repo. In every repo after that, it just initializes.

The user never writes an MCP config line, a `.gitignore` entry, a CI step, or a decision about where a fact belongs.

**Why the CLI is the install and MCP is the runtime.** Every MCP server with a clean one-line install is a *remote* server - it runs on the vendor's infrastructure and you register a URL. docsic reads and writes files in your repo, so it must run locally over stdio, and stdio registration is verbose by nature. Rather than hand the user that string, the CLI writes it for them. MCP remains the interface every session actually uses (§9); the CLI exists only so the install is one short line.

**Naming affects this.** The install string is mostly the package name, so it should be short and actually available on npm. The working name `ctx` was taken; the package ships as `docsic`, and the bin, MCP server name, tool prefix (`docsic_*`), config (`docs/docsic.json`) and managed store (`~/.docsic`) all match. Pre-rename installs are adopted: a `docs/ctx.json` is still read, `~/.ctx` is moved to `~/.docsic` on first use, and `init` replaces old `ctx` registrations.

## 2. What this is not

- **Not a memory store.** Retrieval is the easy half. The hard half is keeping what you retrieve *true*.
- **Not a codebase index.** An index is generated and disposable. These are documents a human reads and reviews.
- **Not task tracking.** See §10.

The thesis: **context quality is a freshness problem, not a retrieval problem.** The system is documentation-as-code with a lifecycle and a gate.

---

## 3. Storage model

Two classes of context with different physics. Conflating them is the mistake every version of this makes.

| Class | Home | Rationale |
|---|---|---|
| **Derived from code** - `docs/`, including `docs/docsic.json` (config) | The repo, committed | Must branch and merge with the code it describes or it lies. Reviewable in PRs, which is the only mechanism that has ever kept docs honest. Readable by teammates who do not use docsic - a clone carries every command and port. |
| **Everything else** - state, notes, adapter settings | Managed | Does not branch. Changes several times a day. In git it is diff noise and merge conflicts, and worktrees would each get a divergent copy. |

**Managed** means: local-first at `~/.docsic/<repo-identity>/`, keyed by git remote URL so every worktree of a repo shares one store. The URL is normalized first (ssh and https forms collapse, `.git` suffix dropped, lowercased); a repo with no remote is keyed by a hash of its root path and re-keyed when a remote appears. No account, works offline. An optional sign-in syncs it, which is what buys cross-machine, cross-harness, and eventually team sharing.

The user's mental model, if they ever ask: *docs are for people and live in your repo; everything else is for the agent and we keep it.* They never open either location by hand. docsic touches exactly one directory in the repo: `docs/`.

**No-repo mode** (`repo: false`): for read-only checkouts - an OSS contribution, a client repo, a codebase you cannot commit to - `docs/` also lives in the managed store. Zero repo footprint. A mode, never the default.

---

## 4. The doc set

Every doc is optional except `architecture.md`. Include what the project actually has.

| Doc | When | Owns |
|-----|------|------|
| `docsic.json` | always | Config: every command-grade fact (§13). Machine-read, not a document; exempt from the hub index |
| `architecture.md` | always | The hub: what the system is, repo layout, stack, component relationships, doc index |
| `local-dev.md` | always | Clone-to-running narrative, prerequisites, gotchas |
| `deployment.md` | always | Deploy targets, build, prod environment, CI/CD |
| `api.md` | server API exists | Routes, models, auth, wire contracts |
| `frontend.md` | web UI exists | Routes/pages, components, state, API integration |
| `data-flow.md` | nontrivial data movement | Request lifecycle, key flows, external integrations |
| `worker.md` | background jobs exist | Jobs, queues, schedules, retries |
| `design-system.md` | project has a design language | Tokens, type, voice, component rules |
| `<surface>.md` (`ios.md`) | per additional client | That surface's stack, layout, run and test procedure |
| `<subsystem>.md` | subsystem outgrows the hub | Deep dive; the hub keeps a summary and a link |
| `plans/` | as needed | Dated one-off artifacts with a lifecycle (§6) |
| `reference/` | as needed | Captured payloads and snapshots (§7) |

### Doc frontmatter

Every narrative doc carries:

```yaml
---
owns: [src/api/**, backend/routers/**]   # code paths this doc describes; required
status: current                           # current | superseded
---
```

- `owns` is what makes `doc-staleness` computable, and its inverse is `doc-missing`: a code directory matched by no doc's `owns` is a candidate for a doc.
- `status: superseded` lets a doc stay linked from the hub without agents treating it as truth - the same mechanism `plans/` uses.
- Nothing else. `last-verified` is answered by git; a summary is the hub index row; an owner is meaningless single-user.

### The hub index rule

`architecture.md` contains an index listing **every** `.md` file and subdirectory in `docs/`, with `plans/` and `reference/` each as a single row (`docsic.json` is exempt). "Start at architecture.md, it links everything" must be literally true. A doc missing from the index is a lint failure.

---

## 5. Ownership - each fact has exactly one home

### 5.1 The command-grade rule

Ports, exact commands, env var names, service URLs, model IDs, and credentials are owned by **config**, never by a doc.

This is a **single-file rule**, not a duplication rule. A port number in one doc is already a violation, whether or not it appears in a second. Stating it this way is what makes it mechanically checkable with no false positives.

Docs may describe these facts in narrative - "Redis is not optional, the worker will not start without it" - but never state the value.

*Measured (§15): removed 12 of 21 findings at the source; docs shrank 387 → 369 lines.*

### 5.2 The hub content rule

The hub may state what components exist and how they relate. It may not state a fact another doc owns.

> **Test:** if a code change would force an edit in both the hub and a leaf doc, the hub has the wrong copy.

Without this rule every hub drifts into a summary of the whole system, which makes it the single most stale-prone file in `docs/`.

### 5.3 One owner, two pointers

When several docs need the same fact, one doc owns and states it; the others link.

*Measured (§15): one rationale asserted in three docs; consolidating it improved the explanation, because it was finally written once and written properly.*

### 5.4 Full ownership table

| Home | Owns |
|------|------|
| `docs/*.md` | Current-state truth: structure, contracts, procedures, design language, rationale |
| `docs/plans/` | Historical record. Never current truth. |
| `docs/reference/` | Verbatim captured material |
| `docs/docsic.json` | Command-grade facts: commands, ports, env var names, service URLs, model IDs |
| State (managed) | Where things stand right now |
| Notes (managed) | Knowledge in transit; open until absorbed |
| Adapter settings (managed) | Per-user choices: tracker, hub, harness (§10) |
| `AGENTS.md` / `CLAUDE.md` | Pointers into `docs/`, plus genuine gotchas fitting no doc. **No commands.** |
| `README.md` | The public face and a pointer to `docs/`. Nothing version-volatile. |

**Sanctioned duplication - safety warnings only.** A destructive-command prohibition ("never reset this database, it wipes 144k ingested rows") is deliberately duplicated into config `notes`, `local-dev.md`, and any skill that could run the command. Everything else: one home.

**On conflict:** config wins for command-grade facts (it is the copy agents heal). Docs win for narrative and warnings. Whoever notices fixes the losing copy in the same session.

---

## 6. `plans/` - artifacts with a lifecycle

Implementation plans, rollout runbooks, audits, handoffs, refactor summaries. Real work products that rot into misinformation when left loose in a repo.

- **Name:** `YYYY-MM-DD-<slug>.md`
- **Frontmatter:** `status: active | done | superseded`, `date`, optional `original-path`, `absorbed-into`
- **On ship:** absorb anything durable into the standard docs, then flip to `done`
- **Agents must never** read a `done` or `superseded` plan to answer a current-state question

*Why this is load-bearing:* agent-written files named `*_COMPLETE.md` and `*_SUMMARY.md` accumulate in every agent-heavy repo. An agent grepping the codebase reads them and treats them as current architecture. `status: done` is what stops that. See §15.

---

## 7. `reference/` - captured material

Verbatim external payloads and snapshots: API response dumps, schema snapshots, sample fixtures. Not narrative, not lifecycle - raw material that would bloat a doc but is worth keeping exactly.

- **Frontmatter:** `kind:`, `captured-from:`, optional `verify-against:`
- **Always a point-in-time capture.** Never cited as a live contract.

*This category was forced by real material that fits neither the doc set nor `plans/` (§15). Every repo carrying vendor API samples hits it.*

---

## 8. Memory

### `state`
Where things stand **now**. Replaced wholesale, never appended.

- **Budget: 800 tokens.** Enforced mechanically. Line counts do not work - a v2 state file hit 39 lines and 2,018 words by writing paragraphs as bullets.
- Sections: `## Now`, `## In flight`, `## Next`
- `## Now` is partly derived from git history and open PRs rather than free-written, so it cannot drift into a log
- Rewritten by the session-end distiller where hooks exist (Claude Code, Codex); on hook-less harnesses `docsic_save` is the only write path and the agent is told so in `docsic_load`
- Budget is measured as `ceil(chars / 4)`; the method is fixed so the number means the same thing everywhere

### `notes`
An inbox, not a shelf. Knowledge in transit to future sessions.

- Frontmatter: `title`, `type: discovery | gotcha | decision | idea`, `status: open | absorbed`, `created`
- Open notes inject at session start until absorbed
- **Absorbed means the content reached its permanent home**: a gotcha into `docs/`, a decision into the decision log, an idea into the tracker, or dropped
- Body ≤ 10 lines. A note open past 30 days is a lint warning.

### Work history
**Derived from git, not maintained as a file.** Commits and PR bodies already carry it. A separate maintained log is a second system that drifts and competes with whatever tracker the user already has.

---

## 9. MCP tool surface

MCP is the core. It works on every harness. Five tools, and it should stay five.

| Tool | Returns |
|---|---|
| `docsic_load` | State, open notes, doc map for this repo. The session-start payload. |
| `docsic_recall(query)` | Search across docs, notes, decisions - this repo and, when a hub is configured, all repos |
| `docsic_init` | Scaffold and triage (§11) |
| `docsic_check` | Violations, structured, for the agent to fix (§12) |
| `docsic_save` | Record a state change or a note |

**The server has no model.** A stdio MCP server has no API key and makes no LLM calls. Anything that needs judgment - the `docsic_check` agent pass, the `docsic_init` defect list, the state distiller - is done by the *calling* agent: the tool returns the material and a rubric, the agent does the work, and reports results back through `docsic_save`. Mechanical work (§12 mechanical pass, file moves, git queries) runs inside the server.

**Hooks are a detected upgrade, never a requirement.** When `docsic_init` sees a harness that supports them (Claude Code, Codex), it installs hooks so `docsic_load` fires automatically at session start and the distiller at session end, instead of depending on the agent to remember. Pure latency and reliability. Everything works without them.

**CI is optional.** `check` is a tool the agent calls - on session start, and before claiming a task is done. It repairs rather than blocks, which is strictly better than a pipeline gate. Teams that want a hard gate re-run the same tool in CI. The product must be 100% functional with no CI at all.

---

## 10. Adapters

Three integration points, one shape each. Stored in the managed store (per user, not per repo), swappable in one line.

### `tracker`
The queue. The system needs exactly three operations:

```
list_open()   -> [{id, title, url}]
read(id)      -> {title, body, url}
close(id, ref)
```

Default `github` (Issues - every repo has it, no signup). Also `linear`, `jira`, `beads`. **`none` is first-class**: the system works with no queue and simply stops mentioning open items.

Task tracking is a solved, crowded space. docsic integrates with it and never competes with it.

### `harness`
`claude-code`, `codex`, `cursor`, `mcp` (universal fallback). Determines whether hooks are installed and how context is injected.

### `hub`
`none` (default), or a path/repo for cross-project aggregation. This is where a personal knowledge base plugs in and gains cross-repo recall. Optional, invisible to a first-time user.

---

## 11. `docsic_init`

On a cold repo, init is **triage**, not scaffolding.

### Classification

| Found | Action |
|---|---|
| `*_SUMMARY.md`, `*_COMPLETE.md`, `*_IMPLEMENTATION.md`, `*_DESIGN*.md`, `*_REFACTOR*.md`, `*_FIX*.md` | → `plans/`, `status: done`, date from git history, `original-path` recorded |
| Large verbatim payloads, schema dumps, fixtures | → `reference/` with `kind:` |
| A `README.md` that is actually an architecture document | → content becomes `architecture.md`; README rewritten as a real README |
| Nested `README.md` describing its own directory | left alone |
| Another tool's artifact directory (`.kiro/`, `.cursor/rules`, `.windsurf/`) | **flagged, never touched** |
| Anything ambiguous | listed, not moved |

Nothing is deleted. Files are moved with history preserved and their origin recorded in frontmatter.

### Approval

**One summary table, one confirmation.** Per-file approval on 23 files is worse than the problem it solves. Work happens on a branch, which is the undo.

### Output

Init returns two things:

1. The `docs/` tree
2. **A defect list.** Writing docs forces verification, and verification surfaces real problems - dead test configuration, hardcoded values that block deployment, artifacts committed by mistake, READMEs describing a stack the project no longer uses. None of it asked for; all of it found on the way to writing something else. §15 has a real one.

The defect list is the product's first impression. A user points docsic at a repo they are embarrassed by and gets back a map plus a list of real problems, before reading a word of documentation.

---

## 12. `docsic_check`

Two passes. **Both ship in v1.** This is agentic docs-as-code; a purely mechanical linter cannot see the half of the problem that matters most.

### Mechanical - deterministic, free, runs on every load

| Rule | Checks |
|---|---|
| `hub-index-complete` | Every `.md` file and subdirectory in `docs/` appears in the hub index |
| `doc-frontmatter` | Every narrative doc has `owns:` and a valid `status:` |
| `hub-index-valid` | No index row points at a missing file |
| `command-grade-misplaced` | No port, shell command, env var name, service URL, or model ID appears in any doc (§5.1) |
| `plan-frontmatter` | Every `plans/` file has a valid `status:` and a dated filename |
| `reference-frontmatter` | Every `reference/` file has `kind:` |
| `agents-file-clean` | `AGENTS.md` / `CLAUDE.md` contains no commands |
| `links-resolve` | Relative links inside `docs/` resolve |
| `doc-staleness` | A doc whose `owns:` paths have commits newer than the doc's last commit |
| `state-budget` | State exceeds its token budget |
| `note-stale` | A note has been `open` past 30 days |

A doc that must quote command-grade facts as examples (a spec, a style guide) opts out of `command-grade-misplaced` for the whole file with the comment `<!-- docsic: allow command-grade -->` near the top. It is an escape hatch, not a convention.

**Do not check duplicated file paths.** Two docs citing the same source file while stating different facts about it is correct. Measured precision: ~43% on paths, ~100% on the strong classes (env var, port, command, URL, model). See §15.

### Agent pass - runs at the ship gate and on demand

| Rule | Checks |
|---|---|
| `fact-ownership` | The same claim asserted in two docs |
| `hub-altitude` | The hub stating a fact a leaf doc owns (§5.2) |
| `doc-vs-code` | A doc claim contradicted by source |
| `plan-cited-as-truth` | A `done` plan referenced as current |
| `doc-missing` | A code directory matched by no doc's `owns:` that looks like a subsystem |

These are invisible to mechanical checks - the violations share no token with each other. In validation, the agent pass is what caught a rationale restated across three docs, a stack claim in two, and a behavior description re-derived in two more.

It also has to make judgment calls mechanical cannot. Example: the same phrase appearing in `local-dev.md` as a property and in `deployment.md` as a blocker is acceptable - two different claims about the same fact.

---

## 13. Config schema

`docs/docsic.json`, committed with the docs. Written by init, healed by any agent that discovers a fact the hard way. Adapter choices are not here - they are per user and live in the managed store.

```json
{
  "updated": "2026-08-23",
  "stacks": [
    { "name": "web", "dir": ".", "runner": "vitest",
      "testCommand": "npx vitest run", "buildCommand": "npm run build" }
  ],
  "devServer": { "command": "npm run dev", "port": 3000, "baseUrl": "http://localhost:3000" },
  "backend":   { "baseUrl": "...", "startCommand": "...", "seedCommand": null, "resetCommand": null },
  "worker":    { "startCommand": "...", "broker": "..." },
  "lifecycle": { "startAll": "./dev.sh", "platform": "..." },
  "env":       { "backend": { "file": ".env", "required": [], "optional": [] } },
  "models":    { "agentDefault": "..." },
  "auth":      { "bypassEnv": "E2E_TEST_AUTH", "notes": "dev-only" },
  "routes":    { "key": ["/"], "skip": ["/login"] },
  "notes":     "flaky suites, required services, destructive-command warnings"
}
```

**Trust but verify.** Entries are hints. A command that fails in a way that smells stale (script gone, port moved) triggers rediscovery and a write-back in the same session.

---

## 14. Open for v2

1. **Team semantics.** Everything above is designed for one person across many repos. Shared managed state, review of doc changes, and who runs the distiller all change with a team.
2. **Health metrics.** Rediscovery events (an agent re-learning something the system should have known), unabsorbed notes, docs age vs code age. This is the number that says whether any of it works. The signals exist; nothing aggregates them yet.
3. **Migration for repos already on a convention.** Roughly half a portfolio may already have a `docs/` tree. Init must detect and reconcile rather than triage from scratch.

---

## 15. Validation record

Every rule above marked *Measured* comes from one migration: **Cordinate-App**, a dormant React + FastAPI travel app. 1,123 tracked files, 33 markdown files, no structure, no convention, no test manifest. Chosen because it is the cold-start case - a repo that had never heard of this system.

### Before

- 14 agent-written `*_SUMMARY.md` / `*_COMPLETE.md` files inside a `tests/` directory
- 5 raw vendor API response dumps at the repo root
- 3 loose design documents at the repo root
- A `README.md` that was a 255-line database schema report
- A nested `README.md` naming a CSS framework the app does not use and a directory path that does not exist
- Another agent tool's spec directory (`.kiro/`), untouched by design

### After

`docs/` with 7 narrative docs (369 lines), `plans/` with 18 dated files at `status: done`, `reference/` with 6 captured payloads, and a config file holding every command-grade fact. Zero code touched.

### Numbers

| Measure | Result |
|---|---|
| Mechanical ownership findings, before → after | 21 → 1 (the one remaining is a known false-positive class) |
| Findings eliminated by moving command-grade facts to config | 12 of 21 |
| Doc length, before → after the ownership pass | 387 → 369 lines |
| Detector precision, strong token classes | ~100% |
| Detector precision, file-path class | ~43% (dropped from the ruleset) |
| Violations invisible to mechanical checks | 4, all rationale or characterization |

### Defect list produced as a byproduct

1. `pytest.ini` pointed `testpaths` at a directory that no longer existed - a bare `pytest` collected zero tests, silently
2. The Celery broker URL was hardcoded in source, blocking any non-local deployment
3. A Python virtualenv was committed to git: 579 of 1,123 tracked files
4. A Redis snapshot (`dump.rdb`) was committed in two locations
5. A README claimed a CSS framework the app does not use, and a directory path that does not exist

Nobody asked for any of these. They surfaced because writing a true document requires verifying claims.
