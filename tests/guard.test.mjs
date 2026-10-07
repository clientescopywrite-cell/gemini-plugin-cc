// Decisions of the agy PreToolUse guard, fed the same JSON agy sends on stdin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guard = path.join(root, "plugins", "gemini", "agy-plugins", "claude-companion-guard", "guard.cjs");
const workspace = path.join(os.tmpdir(), "guard-test-workspace");

function decide(policy, name, args) {
  const env = { ...process.env };
  delete env.GEMINI_COMPANION_POLICY;
  if (policy) {
    env.GEMINI_COMPANION_POLICY = policy;
  }
  const result = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ toolCall: { name, args }, workspacePaths: [workspace] }),
    env,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

const run = (command) => ({ CommandLine: command });

test("stays silent outside companion runs", () => {
  assert.equal(decide(null, "run_command", run("git push origin main")), null);
  assert.equal(decide(null, "write_to_file", { TargetFile: "/etc/hosts" }), null);
});

test("read-only runs allow read commands and deny everything else", () => {
  assert.equal(decide("read-only", "run_command", run("git status --short")), null);
  assert.equal(decide("read-only", "run_command", run("git diff HEAD~1")), null);
  assert.equal(decide("read-only", "run_command", run("npm test"))?.decision, "deny");
  assert.equal(decide("read-only", "write_to_file", { TargetFile: path.join(workspace, "a.txt") })?.decision, "deny");
});

test("write runs allow the dev allowlist", () => {
  assert.equal(decide("write", "run_command", run("npx vitest run src/a.test.ts")), null);
  assert.equal(decide("write", "run_command", run("git commit -m fix")), null);
  assert.equal(decide("write", "replace_file_content", { TargetFile: path.join(workspace, "src", "a.ts") }), null);
});

test("write runs deny dangerous commands", () => {
  for (const command of ["git push origin main", "git switch -c x", "git config user.name x", "ssh host", "docker ps", "npx prisma migrate deploy", "gh pr merge 1"]) {
    assert.equal(decide("write", "run_command", run(command))?.decision, "deny", command);
  }
});

test("write runs deny compound commands and commands outside the allowlist", () => {
  assert.equal(decide("write", "run_command", run("npm test && git push"))?.decision, "deny");
  assert.equal(decide("write", "run_command", run("node -e \"1\""))?.decision, "deny");
  assert.equal(decide("write", "run_command", run("curl https://example.com"))?.decision, "deny");
});

test("edits under .git and paths outside the workspace are denied", () => {
  assert.equal(decide("write", "write_to_file", { TargetFile: path.join(workspace, ".git", "config") })?.decision, "deny");
  assert.equal(decide("write", "write_to_file", { TargetFile: path.join(os.tmpdir(), "elsewhere.txt") })?.decision, "deny");
  assert.equal(decide("read-only", "view_file", { AbsolutePath: path.join(os.tmpdir(), "elsewhere.txt") })?.decision, "deny");
  assert.equal(decide("read-only", "run_command", run("ls .."))?.decision, "deny");
});

test("tools with effects outside the repository are denied", () => {
  for (const name of ["send_message", "call_mcp_tool", "read_url_content", "schedule"]) {
    assert.equal(decide("write", name, {})?.decision, "deny", name);
  }
});
