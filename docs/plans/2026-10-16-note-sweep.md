---
status: done
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

Shipped as docsic 0.4.0: all three steps, as planned, with these choices and changes.

- **Archive**: `notes/archive/<file>`, the note moved whole, gaining `outcome`, `archived`, `reason`, `into`. `docsic_save` absorb archives too, with an outcome. The 57 notes absorbed before the archive existed moved into it on throu's first sweep.
- **Trigger**: more than 10 due notes (not judged by a sweep in 7 days), or a week since the last sweep; one sweep per project per 12 hours. Opt-in as `sweep: auto` (off by default; dotclaude's pin bump turns it on).
- **Guard rails**: only existing files under `docs/` and `CLAUDE.md`/`AGENTS.md`; an instruction file stays within 80 lines with no added line over 300 characters; a doc that gains a check error is reverted, the command-grade rules only in repos that ran `init`. Hub homes are every existing doc beside `state.md` but the README, not only `decisions.md` (the dry run left notes open whose home was `app-store-launch.md`).
- **Not merged by the sweep, this time**: Claude Code's auto mode refused to let the agent start a run that merges a PR nobody reviews, so the owner chose to review it. `--no-merge` (and `sweep: pr`) stops at the open PR; its notes stay open, and once it merges the next sweep finds them covered.

throu, 2026-10-16: 137 open notes judged in five agent runs. 82 left the open set (49 covered, 24 retired, 9 absorbed into the hub's `decisions.md` and `fundraising.md`), each in the archive with its reason; `docsic recall --hub` finds them. 8 were renewed on evidence. 47 stayed open: 17 written into throu docs PR #371 (awaiting the owner's review), 12 whose doc edits were reverted by the command-grade rule (throu never ran `init`; fixed before this shipped), 18 with no clear home.

So the open set went from 137 to 55, not yet short. Once #371 merges, the next sweep should find its 17 covered and place the 12, leaving about 26.
