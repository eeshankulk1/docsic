import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

// Tests block on git and tsx subprocesses, so under load a worker can go a minute without a turn
// of the event loop and vitest fails the run on its own message timeout. Give it one between tests.
afterEach(() => new Promise(res => setTimeout(res)));

// No test may reach this machine's real rollcall: it matches a session id by prefix, so a test's
// "b" can resolve to a live supervisor session and change what the hooks print. A stub first on
// PATH answers nothing, which is a plain session; tests that need rollcall put their own fake ahead of it.
const bin = mkdtempSync(join(tmpdir(), "docsic-no-rollcall-"));
writeFileSync(join(bin, "rollcall"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "rollcall"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
delete process.env.ROLLCALL_TASK;
