// Stopping jobs must work when the companion runs from Git Bash (Claude Code's Bash tool on Windows).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { terminateProcessTree } from "../plugins/gemini/scripts/lib/process.mjs";

test("terminateProcessTree stops a child even when SHELL points to bash", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const previousShell = process.env.SHELL;
  if (process.platform === "win32") {
    // Git Bash rewrites "/PID", "/T" and "/F" into paths when taskkill goes through it.
    process.env.SHELL = "bash";
  }
  try {
    const result = terminateProcessTree(child.pid);
    assert.equal(result.delivered, true);
  } finally {
    if (previousShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = previousShell;
    }
  }
  const outcome = await exited;
  assert.ok(outcome.code !== 0 || outcome.signal, "the child should have been killed");
});
