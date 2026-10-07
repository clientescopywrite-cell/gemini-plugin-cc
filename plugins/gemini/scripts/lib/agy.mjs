import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runCommand, terminateProcessTree } from "./process.mjs";

// Default engine: the Antigravity CLI (agy), Google's successor to the Gemini
// CLI for personal Google accounts. It runs headless with stream-json input and
// output; each run's policy (read-only or write) is enforced by the guard
// installed into agy (agy-plugins/claude-companion-guard) together with the
// permissions.allow rules the setup writes.

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GUARD_NAME = "claude-companion-guard";
const GUARD_SOURCE_DIR = path.join(PLUGIN_ROOT, "agy-plugins", GUARD_NAME);
const GUARD_FILES = ["plugin.json", "hooks.json", "guard.cjs", "allowlist.json"];
const AGY_HOME = path.join(os.homedir(), ".gemini");
const GUARD_INSTALLED_DIR = path.join(AGY_HOME, "config", "plugins", GUARD_NAME);
const AGY_SETTINGS = path.join(AGY_HOME, "antigravity-cli", "settings.json");
const INSTALL_HINT = "see https://antigravity.google/docs/getting-started?tab=cli";

const MAX_CAPTURE = 64 * 1024;
const SAFE_TOKEN = /^[A-Za-z0-9._:/-]+$/;
const WRITE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"]);
const VERIFICATION_RE =
  /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|playwright|cargo test|npm test|pnpm test|yarn test|go test|tsc|eslint|ruff)\b/i;
const AUTH_RE = /(not (logged|signed) in|unauthenticated|authenticate|login required|sign in)/i;

export const ENGINE_LABEL = "Antigravity CLI (agy)";
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from where you left off. Pick the current task back up and finish it unless you need a decision from the user.";

let cachedBinary;

export function resolveAgyBinary() {
  if (cachedBinary !== undefined) {
    return cachedBinary;
  }
  const names = process.platform === "win32" ? ["agy.exe", "agy"] : ["agy"];
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, "agy", "bin"));
  }
  dirs.push(path.join(os.homedir(), ".local", "bin"));
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        cachedBinary = candidate;
        return cachedBinary;
      }
    }
  }
  cachedBinary = null;
  return cachedBinary;
}

export function getEngineAvailability(cwd) {
  const binary = resolveAgyBinary();
  if (!binary) {
    return { available: false, detail: `agy not found (${INSTALL_HINT})` };
  }
  const result = runCommand(binary, ["--version"], { cwd, shell: false });
  if (result.error || result.status !== 0) {
    return { available: false, detail: result.error?.message ?? (result.stderr.trim() || `exit ${result.status}`) };
  }
  const version = result.stdout.trim().split(/\r?\n/).pop() || "ok";
  return { available: true, detail: `agy ${version} (${binary})`, version, binary };
}

// agy does not expose its sign-in state without calling the model; the live probe confirms it.
export function getEngineAuthStatus() {
  const binary = resolveAgyBinary();
  if (!binary) {
    return { loggedIn: false, method: null, detail: "agy is not installed" };
  }
  const hasState = fs.existsSync(path.join(AGY_HOME, "antigravity-cli", "installation_id"));
  return {
    loggedIn: hasState,
    method: "agy",
    detail: hasState ? "Antigravity account (confirmed by the live probe)" : "agy has never been opened; sign in with `/gemini:setup --login`"
  };
}

// ---------------------------------------------------------------- guard and permissions

function fileHash(filePath) {
  try {
    return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

export function readAllowlist() {
  return JSON.parse(fs.readFileSync(path.join(GUARD_SOURCE_DIR, "allowlist.json"), "utf8"));
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// In agy 1.3, `command(git status)` does not match "git status --short" (only
// the first token counts as a prefix); the regex form matches the whole line.
function requiredPermissionRules() {
  const allowlist = readAllowlist();
  return [...allowlist.readOnly, ...allowlist.dev].map((prefix) => `command(regex:(?i)${escapeRegex(prefix)}( .*)?)`);
}

function readAgySettings() {
  try {
    return JSON.parse(fs.readFileSync(AGY_SETTINGS, "utf8"));
  } catch {
    return {};
  }
}

export function getEnginePolicyStatus() {
  const guardUpToDate = GUARD_FILES.every((file) => {
    const source = fileHash(path.join(GUARD_SOURCE_DIR, file));
    return source && source === fileHash(path.join(GUARD_INSTALLED_DIR, file));
  });
  const allow = new Set(readAgySettings()?.permissions?.allow ?? []);
  const missingRules = requiredPermissionRules().filter((rule) => !allow.has(rule));
  return {
    ok: guardUpToDate && missingRules.length === 0,
    guardUpToDate,
    missingRules,
    detail: [
      guardUpToDate ? "guard installed in agy" : "agy guard missing or outdated",
      missingRules.length === 0 ? "permission rules ok" : `${missingRules.length} permission rules missing`
    ].join("; ")
  };
}

// Installs the guard into agy and writes the permissions.allow rules. Idempotent.
export function ensureEnginePolicy() {
  const actions = [];
  const status = getEnginePolicyStatus();
  const binary = resolveAgyBinary();
  if (!binary) {
    throw new Error("agy not found.");
  }

  if (!status.guardUpToDate) {
    runCommand(binary, ["plugin", "uninstall", GUARD_NAME], { shell: false });
    const install = runCommand(binary, ["plugin", "install", GUARD_SOURCE_DIR], { shell: false });
    if (install.status !== 0) {
      throw new Error(`Failed to install the guard into agy: ${install.stderr.trim() || install.stdout.trim()}`);
    }
    actions.push(`Installed the ${GUARD_NAME} guard into agy.`);
  }

  if (status.missingRules.length > 0) {
    const settings = readAgySettings();
    const allow = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
    settings.permissions = { ...(settings.permissions ?? {}), allow: [...allow, ...status.missingRules] };
    fs.mkdirSync(path.dirname(AGY_SETTINGS), { recursive: true });
    // No BOM: agy rejects the whole file when it starts with a BOM and falls back to defaults.
    fs.writeFileSync(AGY_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    actions.push(`Added ${status.missingRules.length} permissions.allow rules to ${AGY_SETTINGS}.`);
  }
  return actions;
}

// Opens a terminal window running interactive agy so the user can sign in.
export function openLoginWindow() {
  const binary = resolveAgyBinary();
  if (!binary) {
    throw new Error("agy not found.");
  }
  if (process.platform !== "win32") {
    return { opened: false, detail: `Run \`${binary}\` in a terminal and sign in.` };
  }
  const script = [
    "$host.UI.RawUI.WindowTitle = 'Antigravity CLI (agy) sign-in'",
    "Write-Host 'Sign in to Antigravity below. You can close this window afterwards.' -ForegroundColor Cyan",
    `& '${binary.replace(/'/g, "''")}'`
  ].join("; ");
  const child = spawn("cmd.exe", ["/c", "start", '""', "powershell", "-NoExit", "-Command", script], {
    cwd: os.homedir(),
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return { opened: true, detail: "Opened an agy window for sign-in." };
}

// ---------------------------------------------------------------- execution

function shorten(text, limit = 160) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function toolTarget(params = {}) {
  return (
    params.TargetFile ?? params.AbsolutePath ?? params.FilePath ?? params.File ?? params.Path ?? params.DirectoryPath ?? params.SearchPath ?? ""
  );
}

function describeToolUse(name, params = {}) {
  switch (name) {
    case "run_command":
      return `Running command: ${shorten(params.CommandLine ?? params.Command)}`;
    case "view_file":
      return `Reading ${toolTarget(params)}`;
    case "write_to_file":
      return `Writing ${toolTarget(params)}`;
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
      return `Editing ${toolTarget(params)}`;
    case "list_dir":
      return `Listing ${toolTarget(params)}`;
    case "find_by_name":
      return `Finding files: ${shorten(params.Pattern ?? JSON.stringify(params), 120)}`;
    case "grep_search":
      return `Searching code: ${shorten(params.Query ?? params.Pattern ?? JSON.stringify(params), 120)}`;
    case "search_web":
      return `Searching the web: ${shorten(params.query ?? params.Query ?? JSON.stringify(params), 120)}`;
    case "invoke_subagent":
    case "define_subagent":
      return `Subagent: ${shorten(JSON.stringify(params), 120)}`;
    default:
      return `Tool ${name}: ${shorten(JSON.stringify(params), 120)}`;
  }
}

function phaseForTool(name, params, write) {
  if (WRITE_TOOLS.has(name)) {
    return "editing";
  }
  if (name === "run_command") {
    return VERIFICATION_RE.test(String(params?.CommandLine ?? "")) ? "verifying" : write ? "running" : "investigating";
  }
  return "investigating";
}

function gitStatusSnapshot(cwd) {
  const result = runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, shell: false });
  return result.status === 0 ? new Set(result.stdout.split(/\r?\n/).filter(Boolean)) : null;
}

function changedFilesBetween(before, after) {
  if (!before || !after) {
    return [];
  }
  const files = [];
  for (const line of after) {
    if (!before.has(line)) {
      files.push(line.slice(3).trim());
    }
  }
  for (const line of before) {
    if (!after.has(line)) {
      files.push(line.slice(3).trim());
    }
  }
  return files;
}

function emit(onProgress, payload) {
  onProgress?.(payload);
}

/**
 * Runs one agy turn and returns the final answer.
 * Resuming uses --conversation <id>; read-only runs use --mode plan.
 */
export async function runEngineTurn(cwd, options = {}) {
  const binary = resolveAgyBinary();
  if (!binary) {
    throw new Error("agy not found. Run `/gemini:setup`.");
  }
  const write = Boolean(options.write);
  const prompt = String(options.prompt || options.defaultPrompt || "").trim();
  if (!prompt) {
    throw new Error("Empty prompt for agy.");
  }

  ensureEnginePolicy();

  const args = ["--output-format", "stream-json", "--input-format", "stream-json", "--mode", write ? "accept-edits" : "plan"];
  if (options.resumeSessionId) {
    if (!SAFE_TOKEN.test(options.resumeSessionId)) {
      throw new Error(`Invalid conversation id: ${options.resumeSessionId}`);
    }
    args.push("--conversation", options.resumeSessionId);
  }
  if (options.model) {
    if (!SAFE_TOKEN.test(options.model)) {
      throw new Error(`Invalid model: ${options.model}`);
    }
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.jsonSchemaPath) {
    args.push("--json-schema", options.jsonSchemaPath);
  }

  const before = write ? gitStatusSnapshot(cwd) : null;
  const tools = new Map();
  const touched = new Set();
  const warnings = [];
  const segments = [""];
  let conversationId = options.resumeSessionId ?? null;
  let resultEvent = null;
  let stderr = "";
  let rawNonJson = "";
  let lineBuffer = "";
  let timedOut = false;

  emit(options.onProgress, {
    message: options.resumeSessionId ? `Resuming agy conversation ${options.resumeSessionId}.` : "Starting a new agy conversation.",
    phase: "starting",
    threadId: conversationId
  });

  const child = spawn(binary, args, {
    cwd,
    env: { ...process.env, GEMINI_COMPANION_POLICY: write ? "write" : "read-only", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  emit(options.onProgress, { message: "", childPid: child.pid ?? null });

  const flushSegment = () => {
    const current = segments[segments.length - 1];
    if (current.trim()) {
      emit(options.onProgress, { message: "", logTitle: "Gemini message", logBody: current.trim() });
      segments.push("");
    }
  };

  const handleTool = (step) => {
    const key = step.step_index;
    const info = step.tool_info ?? {};
    const name = step.tool_name ?? info.name ?? "?";
    const params = info.parameters ?? {};
    if (!tools.has(key)) {
      flushSegment();
      tools.set(key, { name, params, done: false });
      if (WRITE_TOOLS.has(name) && toolTarget(params)) {
        const target = toolTarget(params);
        touched.add(path.isAbsolute(target) ? path.relative(cwd, target) || target : target);
      }
      emit(options.onProgress, { message: describeToolUse(name, params), phase: phaseForTool(name, params, write) });
    }
    const tracked = tools.get(key);
    if (tracked.done || step.state === "ACTIVE") {
      return;
    }
    tracked.done = true;
    if (info.error || step.state === "ERROR") {
      emit(options.onProgress, {
        message: `Tool denied or failed (${name}): ${shorten(info.error?.message ?? info.output, 220)}`
      });
    } else if (name === "run_command") {
      emit(options.onProgress, { message: `Command finished: ${shorten(params.CommandLine)}` });
    }
  };

  const handleEvent = (event) => {
    switch (event.event) {
      case "init":
        conversationId = event.conversation_id ?? conversationId;
        emit(options.onProgress, {
          message: `Conversation ${conversationId} ready (permissions: ${event.init?.permission_mode ?? "?"}).`,
          phase: "running",
          threadId: conversationId
        });
        break;
      case "step_update": {
        const step = event.step_update ?? {};
        conversationId = step.conversation_id ?? conversationId;
        if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
          segments[segments.length - 1] += step.text_delta;
        } else if (step.step_type === "tool") {
          handleTool(step);
        }
        break;
      }
      case "result":
        resultEvent = event.result ?? {};
        conversationId = resultEvent.conversation_id ?? conversationId;
        flushSegment();
        emit(options.onProgress, { message: `Turn finished (${resultEvent.status ?? "?"}).`, phase: "finalizing" });
        break;
      default:
        break;
    }
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    lineBuffer += chunk;
    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = lineBuffer.slice(0, newlineIndex).trim();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      newlineIndex = lineBuffer.indexOf("\n");
      if (!line) {
        continue;
      }
      try {
        handleEvent(JSON.parse(line));
      } catch {
        if (rawNonJson.length < MAX_CAPTURE) {
          rawNonJson += `${line}\n`;
        }
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < MAX_CAPTURE) {
      stderr += chunk;
    }
  });
  child.stdin.on("error", () => {});
  child.stdin.end(`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);

  let timer = null;
  if (options.timeoutMs && Number(options.timeoutMs) > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      emit(options.onProgress, { message: "Timeout reached; stopping agy.", phase: "failed" });
      try {
        terminateProcessTree(child.pid ?? Number.NaN);
      } catch {
        // best effort
      }
    }, Number(options.timeoutMs));
    timer.unref?.();
  }

  const exit = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: null, error }));
    child.on("close", (code) => resolve({ code, error: null }));
  });
  if (timer) {
    clearTimeout(timer);
  }

  const response = typeof resultEvent?.response === "string" ? resultEvent.response.trim() : "";
  const finalMessage = response || ([...segments].reverse().find((segment) => segment.trim())?.trim() ?? "");
  for (const file of changedFilesBetween(before, write ? gitStatusSnapshot(cwd) : null)) {
    touched.add(file);
  }

  const status = resultEvent?.status ?? null;
  let errorMessage = null;
  if (exit.error) {
    errorMessage = exit.error.message;
  } else if (timedOut) {
    errorMessage = `agy exceeded the ${Math.round(Number(options.timeoutMs) / 1000)}s time limit.`;
  } else if (status && status !== "SUCCESS") {
    errorMessage = resultEvent?.error?.message ?? `agy finished with status ${status}.`;
  } else if (exit.code !== 0) {
    errorMessage = stderr.trim().slice(-4000) || `agy exited with code ${exit.code}.`;
  } else if (!finalMessage && !resultEvent?.structured_output) {
    errorMessage = stderr.trim() ? `agy returned no answer: ${stderr.trim().slice(-2000)}` : "agy finished without an answer.";
  }

  return {
    status: errorMessage ? (exit.code && exit.code !== 0 ? exit.code : 1) : 0,
    threadId: conversationId,
    model: options.model ?? null,
    finalMessage,
    structuredOutput: resultEvent?.structured_output ?? null,
    fullText: segments.join("").trim(),
    touchedFiles: [...touched].sort(),
    warnings,
    stats: resultEvent?.usage ?? null,
    stderr: stderr.trim(),
    error: errorMessage ? { message: errorMessage } : null,
    authRequired: Boolean(errorMessage && AUTH_RE.test(errorMessage))
  };
}

export async function probeEngine(cwd) {
  const result = await runEngineTurn(cwd, { prompt: "Reply with exactly one word: ok", write: false, timeoutMs: 120000 });
  if (result.status === 0) {
    return { ok: true, detail: `replied "${shorten(result.finalMessage, 40)}"` };
  }
  return { ok: false, detail: result.error?.message ?? "failed", authRequired: result.authRequired };
}
