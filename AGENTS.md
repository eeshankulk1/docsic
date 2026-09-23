# docsic

Start at `docs/architecture.md` - it indexes every doc. Exact commands are in `docs/docsic.json`; never copy them here.

## Gotchas

- The server has no model. Anything needing judgment is returned to the calling agent as a rubric, never computed here.
- Five tools, and it stays five. New behavior goes into an existing tool's payload.
