import { defineConfig } from "vitest/config";

// Tests spawn git and tsx subprocesses; the 5s default flakes under parallel load.
export default defineConfig({ test: { testTimeout: 30_000 } });
