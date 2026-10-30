import { afterEach } from "vitest";

// Tests block on git and tsx subprocesses, so under load a worker can go a minute without a turn
// of the event loop and vitest fails the run on its own message timeout. Give it one between tests.
afterEach(() => new Promise(res => setTimeout(res)));
