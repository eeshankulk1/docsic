---
status: active
date: 2026-10-16
---

# Note sweep - decay without losing anything

## Problem

- throu has 192 notes, 135 of them open, and 97 written since 2026-10-01. Session start injects a token-budgeted slice and only counts the rest, so most open notes are never seen.
- Notes leave the open set only through a manual `/note triage`.
- Sessions cannot trim each other's lines (throu note 2026-10-05: a state save refused at ~2,070 tokens against an 800 budget).

## Goal

Open notes stay few and current. Every note that leaves the open set lands somewhere findable, with its reason. The owner never runs or reviews doc upkeep.

## Decisions (2026-10-16)

| Decision | Choice |
|---|---|
| Outcomes | Each swept note gets exactly one. **Absorb**: write it into its permanent home. **Covered**: already in docs or code; archive with a pointer. **Renew**: still needed; stays open, may be pinned to the top. **Retire**: wrong or out of date; archive with the reason |
| Nothing deleted | The archive keeps source, date, outcome and reason. `docsic recall` searches it |
| Renewal needs evidence | A note is renewed only on evidence that it is still true and in use (firstmate's `/stow` rule), not because it looks important |
| Trigger | Automatic: when a project's open notes pass a budget, or a week after its last sweep. Runs detached, like the distiller |
| Absorbing into project docs | One docs-only PR per project per sweep, opened and merged by the sweep once checks pass. The owner does not review it. Each note is checked against current main before it is written in |
| Brain hub changes | Committed straight to brain main, as today |
| Where judgment runs | In a detached headless agent, like the distiller. The server stays model-free and keeps its five tools |

## Plan - one session, in this order

1. **Archive and outcomes.** Archive storage and format, recall over it, the four outcomes, pinning, and a short sweep report in state.
2. **Trigger.** The open-note budget and weekly clock, starting a detached sweep the way the distiller starts.
3. **Autonomous docs PRs.** Absorbed content goes into one docs-only PR per project, following each repo's docs standard and `owns:` map, merged on green. Repo CLAUDE.md takes gotchas only, within a line budget, since every line costs every session. When a note's home is unclear, it stays open rather than being guessed into a doc.

Done when a sweep over throu's notes leaves a short open set, every other note sits in the archive or a doc with its reason, and recall still finds all of them.

## Outcome

<!-- Fill when flipping to done. -->
