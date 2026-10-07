#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  DEFAULT_CONTINUE_PROMPT,
  ENGINE,
  ENGINE_LABEL,
  ensureEnginePolicy,
  getEngineAuthStatus,
  getEngineAvailability,
  getEnginePolicyStatus,
  openLoginWindow,
  parseStructuredOutput,
  probeEngine,
  readOutputSchema,
  runEngineTurn
} from "./lib/engine.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { generateJobId, getConfig, listJobs, resolveStateDir, resolveStateRoot, setConfig, upsertJob, writeJobFile } from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  filterJobsForCurrentSession,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
// Gemini handles large contexts: the whole diff goes into the prompt up to these
// limits; above them it gets a summary and collects the diff itself with read-only git.
const REVIEW_MAX_INLINE_FILES = 40;
const REVIEW_MAX_INLINE_DIFF_BYTES = 400 * 1024;
// Short aliases for agy models; full names pass through (`agy models` lists them).
const AGY_MODEL_ALIASES = new Map([
  ["pro", "gemini-3.1-pro-high"],
  ["flash", "gemini-3.8-flash-high"]
]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gemini-companion.mjs setup [--login] [--enable-review-gate|--disable-review-gate] [--skip-probe] [--json]",
      "  node scripts/gemini-companion.mjs review [--base <ref>] [--scope <auto|working-tree|branch>] [--model <m>] [--effort <e>] [focus]",
      "  node scripts/gemini-companion.mjs adversarial-review [--base <ref>] [--scope <auto|working-tree|branch>] [--model <m>] [--effort <e>] [focus]",
      "  node scripts/gemini-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <m>] [--effort <low|medium|high|xhigh|max>] [--raw] [--timeout-minutes <n>] [--prompt-file <file>] [prompt]",
      "  node scripts/gemini-companion.mjs status [job-id] [--all] [--wait] [--json]",
      "  node scripts/gemini-companion.mjs result [job-id] [--json]",
      "  node scripts/gemini-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return ENGINE === "agy" ? AGY_MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized : normalized;
}

function normalizeEffort(effort) {
  if (effort == null || !String(effort).trim()) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!VALID_EFFORTS.has(normalized)) {
    throw new Error(`Unsupported effort "${effort}". Use low, medium, high, xhigh or max.`);
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function ensureEngineAvailable(cwd) {
  const availability = getEngineAvailability(cwd);
  if (!availability.available) {
    throw new Error(`The ${ENGINE_LABEL} is not ready (${availability.detail}). Run \`/gemini:setup\`.`);
  }
}

function ensureEngineAuthenticated() {
  const auth = getEngineAuthStatus();
  if (!auth.loggedIn) {
    throw new Error(`The ${ENGINE_LABEL} is not signed in (${auth.detail}). Run \`/gemini:setup --login\`.`);
  }
}

// ---------------------------------------------------------------- setup

async function buildSetupReport(cwd, actionsTaken = [], options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const engineStatus = getEngineAvailability(cwd);
  const authStatus = getEngineAuthStatus();
  const policyStatus = engineStatus.available ? getEnginePolicyStatus() : { ok: false, detail: "engine unavailable" };
  const config = getConfig(workspaceRoot);

  let probe = null;
  if (engineStatus.available && authStatus.loggedIn && policyStatus.ok && !options.skipProbe) {
    const probeDir = path.join(resolveStateRoot(), "probe");
    fs.mkdirSync(probeDir, { recursive: true });
    probe = await probeEngine(probeDir);
  }

  const nextSteps = [];
  if (!engineStatus.available) {
    nextSteps.push(
      ENGINE === "agy"
        ? "Install the Antigravity CLI: https://antigravity.google/docs/getting-started?tab=cli (Windows PowerShell: `irm https://antigravity.google/cli/install.ps1 | iex`)."
        : "Install the Gemini CLI with `npm install -g @google/gemini-cli`."
    );
  }
  if (engineStatus.available && (!authStatus.loggedIn || probe?.authRequired)) {
    nextSteps.push("Sign in: `/gemini:setup --login` opens an agy window; sign in there and run `/gemini:setup` again.");
  } else if (probe && !probe.ok) {
    nextSteps.push("The live probe failed; see the detail above (sign-in, quota, network or model).");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: `/gemini:setup --enable-review-gate` makes Gemini review every turn with edits before Claude stops.");
  }

  return {
    ready: nodeStatus.available && engineStatus.available && authStatus.loggedIn && policyStatus.ok && (probe ? probe.ok : true),
    engine: ENGINE_LABEL,
    node: nodeStatus,
    npm: npmStatus,
    gemini: engineStatus,
    auth: authStatus,
    probe,
    policies: policyStatus,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    stateDir: resolveStateDir(workspaceRoot),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "skip-probe", "login"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  if (getEngineAvailability(cwd).available) {
    actionsTaken.push(...ensureEnginePolicy());
  }

  if (options.login) {
    const login = openLoginWindow();
    actionsTaken.push(login.detail);
    const report = await buildSetupReport(cwd, actionsTaken, { skipProbe: true });
    outputResult(options.json ? report : renderSetupReport(report), options.json);
    return;
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken, { skipProbe: options["skip-probe"] });
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

// ---------------------------------------------------------------- review

function buildReviewPrompt(templateName, context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
    OUTPUT_SCHEMA: readOutputSchema(REVIEW_SCHEMA)
  });
}

async function executeReviewRun(request) {
  ensureEngineAvailable(request.cwd);
  ensureEngineAuthenticated();
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const templateName = reviewName === "Adversarial Review" ? "adversarial-review" : "review";
  const context = collectReviewContext(request.cwd, target, {
    maxInlineFiles: REVIEW_MAX_INLINE_FILES,
    maxInlineDiffBytes: REVIEW_MAX_INLINE_DIFF_BYTES
  });
  request.onProgress?.({ message: `${context.summary} (${context.inputMode})`, phase: "reviewing" });

  const result = await runEngineTurn(context.repoRoot, {
    prompt: buildReviewPrompt(templateName, context, focusText),
    model: request.model,
    effort: request.effort,
    jsonSchemaPath: REVIEW_SCHEMA,
    write: false,
    onProgress: request.onProgress
  });
  const failureMessage = result.status !== 0 ? result.error?.message ?? result.stderr : null;
  // agy enforces the schema and returns the object; the Gemini CLI returns text holding JSON.
  const parsed = result.structuredOutput
    ? { parsed: result.structuredOutput, parseError: null, rawOutput: JSON.stringify(result.structuredOutput, null, 2) }
    : parseStructuredOutput(result.finalMessage || result.fullText, { failureMessage });
  const rendered = renderReviewResult(parsed, {
    reviewLabel: reviewName,
    targetLabel: context.target.label,
    failureMessage: !parsed.parsed ? failureMessage : null
  });

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    payload: {
      review: reviewName,
      target,
      threadId: result.threadId,
      model: result.model,
      context: { repoRoot: context.repoRoot, branch: context.branch, summary: context.summary, inputMode: context.inputMode },
      gemini: { status: result.status, stderr: result.stderr, stdout: result.finalMessage, stats: result.stats },
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError
    },
    rendered,
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Gemini ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: `Gemini ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const effort = normalizeEffort(options.effort);
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: normalizeRequestedModel(options.model),
        effort,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

// ---------------------------------------------------------------- task

function buildExecutionPreamble(write) {
  return [
    "<execution_context>",
    "You were invoked by Claude Code, which orchestrates and reviews your work.",
    "You run non-interactively: nobody will answer questions mid-run. Use good judgment and record any assumptions you make.",
    write
      ? "Mode: write access to the workspace. Keep changes within the requested scope. Allowed commands: read-only (git status/diff/log/show, ls, cat, rg), tests, lint, typecheck, build, git add and git commit. Push, branch switching, merge, rebase, remote access, infrastructure and database commands are blocked."
      : "Mode: read-only. Do not edit files. Allowed commands: git status/diff/log/show, ls, cat and rg; investigate and answer.",
    "Run one command at a time, without &&, ;, pipes or redirection. If a command is blocked, do not stop: continue without it and report at the end what you would have needed to run.",
    "When you finish, reply with: what you did, the files you changed (if any), the verification commands you ran and their results, and what is still pending.",
    "</execution_context>",
    ""
  ].join("\n");
}

function buildTaskPrompt(prompt, { write, raw, resume }) {
  if (raw || resume || String(prompt).includes(STOP_REVIEW_TASK_MARKER)) {
    return prompt;
  }
  return `${buildExecutionPreamble(write)}\n${prompt}`;
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return { title: "Gemini Stop Gate Review", summary: "Stop-gate review of the previous Claude turn" };
  }
  const title = resumeLast ? "Gemini Resume" : "Gemini Task";
  return { title, summary: shorten(prompt || DEFAULT_CONTINUE_PROMPT) };
}

function findLatestResumableTaskJob(jobs) {
  return jobs.find((job) => job.jobClass === "task" && job.threadId && job.status !== "queued" && job.status !== "running") ?? null;
}

function resolveLatestTrackedTaskThread(workspaceRoot, options = {}) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /gemini:status before continuing it.`);
  }
  return findLatestResumableTaskJob(visibleJobs)?.threadId ?? null;
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureEngineAvailable(request.cwd);
  ensureEngineAuthenticated();

  const taskMetadata = buildTaskRunMetadata({ prompt: request.prompt, resumeLast: request.resumeLast });

  let resumeSessionId = null;
  if (request.resumeLast) {
    resumeSessionId = resolveLatestTrackedTaskThread(workspaceRoot, { excludeJobId: request.jobId });
    if (!resumeSessionId) {
      throw new Error("No previous Gemini session was found for this repository.");
    }
  }

  if (!request.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a --prompt-file, piped stdin, or use --resume-last.");
  }

  const result = await runEngineTurn(workspaceRoot, {
    resumeSessionId,
    prompt: request.prompt ? buildTaskPrompt(request.prompt, { write: request.write, raw: request.raw, resume: Boolean(resumeSessionId) }) : "",
    defaultPrompt: resumeSessionId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    write: request.write,
    timeoutMs: request.timeoutMs,
    onProgress: request.onProgress
  });

  const rawOutput = result.finalMessage || "";
  const failureMessage = result.status !== 0 ? result.error?.message ?? result.stderr ?? "" : "";
  const rendered = renderTaskResult(
    { rawOutput, failureMessage, touchedFiles: result.touchedFiles },
    { title: taskMetadata.title, jobId: request.jobId ?? null, write: Boolean(request.write) }
  );

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    payload: {
      status: result.status,
      threadId: result.threadId,
      model: result.model,
      rawOutput,
      touchedFiles: result.touchedFiles,
      warnings: result.warnings,
      stats: result.stats,
      error: failureMessage || null
    },
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, { logFile: options.logFile, stderr: !options.json });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "gemini-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = { ...job, status: "queued", phase: "queued", pid: child.pid ?? null, logFile, request, background: true };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: { jobId: job.id, status: "queued", title: job.title, summary: job.summary, logFile },
    logFile
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }
  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file", "timeout-minutes"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "raw"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);
  const timeoutMinutes = Number(options["timeout-minutes"] ?? 0);
  const timeoutMs = Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes * 60000 : null;

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  if (resumeLast && options.fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a --prompt-file, piped stdin, or use --resume-last.");
  }

  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
  const request = { cwd, model, effort, prompt, write, resumeLast, raw: Boolean(options.raw), timeoutMs, jobId: job.id };

  if (options.background) {
    ensureEngineAvailable(cwd);
    ensureEngineAuthenticated();
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(
      payload,
      `${payload.title} started in the background as ${payload.jobId}. Check /gemini:status ${payload.jobId} for progress.\n`,
      options.json
    );
    return;
  }

  await runForegroundCommand(job, (progress) => executeTaskRun({ ...request, onProgress: progress }), { json: options.json });
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "job-id"] });
  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }
  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress({ ...storedJob, workspaceRoot }, { logFile: storedJob.logFile ?? null });
  await runTrackedJob({ ...storedJob, workspaceRoot, logFile }, () => executeTaskRun({ ...request, onProgress: progress }), { logFile });
}

// ---------------------------------------------------------------- status / result / cancel

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);
  const isActive = (status) => status === "queued" || status === "running";

  while (isActive(snapshot.job.status) && !snapshot.job.orphaned && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return { ...snapshot, waitTimedOut: isActive(snapshot.job.status), timeoutMs };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = resolveResultJob(cwd, positionals[0] ?? "");
  const storedJob = readStoredJob(workspaceRoot, job.id);
  outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = process.env[SESSION_ID_ENV] ?? null;
  const jobs = filterJobsForCurrentSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };
  const rendered = candidate ? `Resumable task found: ${candidate.id} (${candidate.status}).\n` : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = resolveCancelableJob(cwd, positionals[0] ?? "", { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  const completedAt = nowIso();
  const nextJob = { ...job, status: "cancelled", phase: "cancelled", pid: null, childPid: null, completedAt, errorMessage: "Cancelled by user." };
  // Mark the job first so the dying worker cannot overwrite the cancelled state.
  writeJobFile(workspaceRoot, job.id, { ...existing, ...nextJob, cancelledAt: completedAt });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    childPid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const pids = [existing.childPid ?? job.childPid, existing.pid ?? job.pid].filter((pid) => Number.isInteger(pid) && pid !== process.pid);
  const stopAll = () => {
    for (const pid of pids) {
      try {
        terminateProcessTree(pid);
      } catch {
        // process already gone
      }
    }
  };
  stopAll();
  // Windows can take a moment to tear a process tree down; confirm and retry once.
  await sleep(1000);
  if (pids.some(isProcessRunning)) {
    stopAll();
    await sleep(1000);
  }
  const engineStopped = !pids.some(isProcessRunning);
  appendLogLine(job.logFile, engineStopped ? "Cancelled by user." : "Cancelled by user, but a process is still running.");

  outputCommandResult({ jobId: job.id, status: "cancelled", title: job.title, engineStopped }, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReviewCommand(argv, { reviewName: "Review" });
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
