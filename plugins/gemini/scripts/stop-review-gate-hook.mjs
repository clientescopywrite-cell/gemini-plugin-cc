#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getEngineAuthStatus, getEngineAvailability } from "./lib/engine.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (message) {
    process.stderr.write(`${message}\n`);
  }
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: lastAssistantMessage ? ["Previous Claude response:", lastAssistantMessage].join("\n") : ""
  });
}

function buildSetupNote(cwd) {
  const availability = getEngineAvailability(cwd);
  if (!availability.available) {
    return `Gemini is not set up for the review gate (${availability.detail}). Run /gemini:setup.`;
  }
  const auth = getEngineAuthStatus();
  if (!auth.loggedIn) {
    return `Gemini is not signed in for the review gate (${auth.detail}). Run /gemini:setup.`;
  }
  return null;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason: "The stop-time Gemini review returned no final output. Run /gemini:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return { ok: false, reason: `The stop-time Gemini review found issues that still need fixes before ending the session: ${reason}` };
  }

  return {
    ok: false,
    reason: "The stop-time Gemini review returned an unexpected answer. Run /gemini:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "gemini-companion.mjs");
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", "--raw", buildStopReviewPrompt(input)], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS,
    windowsHide: true
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason: "The stop-time Gemini review timed out after 15 minutes. Run /gemini:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail ? `The stop-time Gemini review failed: ${detail}` : "The stop-time Gemini review failed."
    };
  }

  try {
    return parseStopReviewOutput(JSON.parse(result.stdout)?.rawOutput);
  } catch {
    return { ok: false, reason: "The stop-time Gemini review returned invalid JSON." };
  }
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Gemini job ${runningJob.id} is still running. Check /gemini:status and use /gemini:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({ decision: "block", reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason });
    return;
  }

  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
