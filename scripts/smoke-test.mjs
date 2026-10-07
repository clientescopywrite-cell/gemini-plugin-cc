// End-to-end smoke test against the real engine (needs a signed-in agy).
// Creates a throwaway git repository with a known bug, then exercises setup,
// read-only tasks, parallel background jobs, a write task, resume, both
// reviews, cancel, timeout and the stop-time review gate.
//
// Usage: node scripts/smoke-test.mjs [--keep]
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(root, "plugins", "gemini");
const companion = path.join(pluginRoot, "scripts", "gemini-companion.mjs");
const hook = path.join(pluginRoot, "scripts", "stop-review-gate-hook.mjs");
const keep = process.argv.includes("--keep");

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-smoke-"));
const repo = path.join(workDir, "repo");
const stateHome = path.join(workDir, "state");
const env = { ...process.env, GEMINI_COMPANION_HOME: stateHome };
delete env.GEMINI_COMPANION_SESSION_ID;

fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "app.js"), "function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n");
fs.writeFileSync(path.join(repo, "test.js"), "const assert = require('node:assert');\nconst { add } = require('./app');\nassert.strictEqual(add(2, 3), 5);\nconsole.log('ok');\n");
fs.writeFileSync(path.join(repo, "package.json"), '{\n  "name": "smoke",\n  "private": true,\n  "scripts": { "test": "node test.js" }\n}\n');
const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("add", "-A");
git("-c", "user.name=smoke", "-c", "user.email=smoke@example.com", "commit", "-qm", "base");

const results = [];

function run(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(process.execPath, [companion, ...args], { cwd: repo, env: { ...env, ...extraEnv }, maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, ms: Date.now() - started, stdout, stderr });
    });
  });
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function check(name, ok, ms, note = "") {
  results.push({ name, ok, ms });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} (${Math.round(ms / 1000)}s) ${note}`.trimEnd());
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

{
  const r = await run(["setup", "--json"]);
  const report = parse(r.stdout);
  check("setup and live probe", r.code === 0 && report?.ready === true, r.ms, report?.probe?.detail ?? r.stderr.trim().slice(-200));
}

for (let i = 1; i <= 2; i += 1) {
  const r = await run(["task", "--json", "Read app.js and describe each exported function in one sentence."]);
  check(`read-only task ${i}`, r.code === 0 && Boolean(parse(r.stdout)?.rawOutput), r.ms);
}

{
  const started = Date.now();
  const a = parse((await run(["task", "--background", "--json", "How many lines does app.js have? Reply with the number only."])).stdout);
  const b = parse((await run(["task", "--background", "--json", "List the exported function names of app.js."])).stdout);
  const ids = [a?.jobId, b?.jobId].filter(Boolean);
  const statuses = [];
  for (const id of ids) {
    statuses.push(parse((await run(["status", id, "--wait", "--timeout-ms", "600000", "--json"])).stdout)?.job?.status);
  }
  check("two background jobs in parallel", ids.length === 2 && statuses.every((s) => s === "completed"), Date.now() - started, statuses.join(","));
}

{
  const r = await run(["task", "--write", "--json", "Fix the bug in add() in app.js and run npm test to confirm. Do not commit."]);
  const testsPass = spawnSync(process.execPath, ["test.js"], { cwd: repo }).status === 0;
  check("write task fixes the bug", r.code === 0 && testsPass, r.ms, `touched=${(parse(r.stdout)?.touchedFiles ?? []).join(",")}`);
}

{
  const r = await run(["task", "--resume-last", "--json", "In one line: what caused the bug?"]);
  check("resume the same conversation", r.code === 0 && Boolean(parse(r.stdout)?.rawOutput), r.ms);
}

for (const kind of ["review", "adversarial-review"]) {
  const r = await run([kind, "--json", "--scope", "working-tree"]);
  const verdict = parse(r.stdout)?.result?.verdict;
  check(kind, r.code === 0 && typeof verdict === "string", r.ms, `verdict=${verdict}`);
}
git("checkout", "--", ".");

{
  const started = Date.now();
  const job = parse((await run(["task", "--background", "--json", "Explain app.js line by line in detail, with usage examples."])).stdout);
  await sleep(8000);
  const stateFile = fs
    .readdirSync(stateHome, { recursive: true })
    .map((entry) => path.join(stateHome, String(entry)))
    .find((entry) => entry.endsWith(`${job?.jobId}.json`));
  const stored = stateFile ? parse(fs.readFileSync(stateFile, "utf8")) : null;
  const cancel = await run(["cancel", job?.jobId ?? "", "--json"]);
  let childLeft = processAlive(stored?.childPid);
  for (let waited = 0; childLeft && waited < 10000; waited += 500) {
    await sleep(500);
    childLeft = processAlive(stored?.childPid);
  }
  const status = parse((await run(["status", job?.jobId ?? "", "--json"])).stdout)?.job?.status;
  check("cancel stops the engine process", cancel.code === 0 && status === "cancelled" && !childLeft, Date.now() - started, `status=${status} engine_alive=${childLeft}`);
}

{
  const r = await run(["task", "--timeout-minutes", "0.05", "--json", "Explain app.js in detail."]);
  const error = parse(r.stdout)?.error ?? r.stderr;
  check("timeout is enforced", r.code !== 0 && /time limit/i.test(error), r.ms);
}

{
  await run(["setup", "--enable-review-gate", "--skip-probe", "--json"]);
  const started = Date.now();
  const gate = spawnSync(process.execPath, [hook], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo, session_id: "smoke", last_assistant_message: "I only showed the job status; no edits." }),
    encoding: "utf8"
  });
  await run(["setup", "--disable-review-gate", "--skip-probe", "--json"]);
  check("stop-time review gate allows a turn without edits", gate.status === 0 && !gate.stdout.includes('"block"'), Date.now() - started);
}

const passed = results.filter((result) => result.ok).length;
console.log(`\n${passed}/${results.length} checks passed.`);
if (!keep) {
  fs.rmSync(workDir, { recursive: true, force: true });
} else {
  console.log(`Kept ${workDir}`);
}
process.exit(passed === results.length ? 0 : 1);
