import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
// A fixed folder (instead of CLAUDE_PLUGIN_DATA): hooks, commands and the
// monitor mod must all see the same state whether or not the variable is set.
const STATE_HOME_ENV = "GEMINI_COMPANION_HOME";
const DEFAULT_STATE_ROOT_DIR = path.join(os.homedir(), ".claude", "gemini-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const MAX_INDEX_JOBS = 40;
const INDEX_FIELDS = [
  "id",
  "title",
  "kindLabel",
  "status",
  "phase",
  "summary",
  "workspaceRoot",
  "logFile",
  "sessionId",
  "write",
  "background",
  "threadId",
  "errorMessage",
  "createdAt",
  "startedAt",
  "completedAt",
  "updatedAt"
];

function nowIso() {
  return new Date().toISOString();
}

// Atomic write: the background worker and the status command read the same
// files. On Windows a rename fails with EPERM/EBUSY while another process reads
// the target, so retry a few times and fall back to a direct write.
function writeFileAtomic(filePath, content) {
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, content, "utf8");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.renameSync(tempFile, filePath);
      return;
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EBUSY" && error?.code !== "EACCES") {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  fs.writeFileSync(filePath, content, "utf8");
  fs.rmSync(tempFile, { force: true });
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateRoot() {
  return process.env[STATE_HOME_ENV] || DEFAULT_STATE_ROOT_DIR;
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return path.join(resolveStateRoot(), `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function resolveIndexFile() {
  return path.join(resolveStateRoot(), "index.json");
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// Global index (every workspace) read by the gemini-monitor mod, which has no
// Node runtime to compute the per-workspace state folder hash.
function updateGlobalIndex(cwd, jobs) {
  try {
    const workspaceRoot = resolveWorkspaceRoot(cwd);
    const indexFile = resolveIndexFile();
    let index = { version: 1, jobs: [] };
    if (fs.existsSync(indexFile)) {
      try {
        index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
      } catch {
        index = { version: 1, jobs: [] };
      }
    }
    const others = (Array.isArray(index.jobs) ? index.jobs : []).filter((job) => job.workspaceRoot !== workspaceRoot);
    const mine = jobs.slice(0, 15).map((job) =>
      Object.fromEntries(INDEX_FIELDS.filter((field) => job[field] !== undefined).map((field) => [field, job[field]]))
    );
    const merged = [...mine.map((job) => ({ workspaceRoot, ...job })), ...others]
      .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
      .slice(0, MAX_INDEX_JOBS);
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    writeFileAtomic(indexFile, `${JSON.stringify({ version: 1, updatedAt: nowIso(), jobs: merged }, null, 2)}\n`);
  } catch {
    // The index only feeds the monitor pane; a failure here never breaks a job.
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeFileIfExists(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  updateGlobalIndex(cwd, nextJobs);
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
