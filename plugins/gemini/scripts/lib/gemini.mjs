import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runCommand, terminateProcessTree } from "./process.mjs";

// Alternative engine: Gemini CLI in headless mode (GEMINI_COMPANION_ENGINE=gemini-cli).
// Since June 18, 2026 the Gemini CLI no longer serves personal Google accounts
// (free, Google AI Pro, Google AI Ultra); it needs GEMINI_API_KEY, Vertex AI or
// a Gemini Code Assist Standard/Enterprise license.

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const POLICY_READ_ONLY = path.join(PLUGIN_ROOT, "policies", "read-only.toml");
export const POLICY_WRITE = path.join(PLUGIN_ROOT, "policies", "write-guard.toml");

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from where you left off. Pick the current task back up and finish it unless you need a decision from the user.";

const GEMINI_HOME = path.join(os.homedir(), ".gemini");
const SAFE_TOKEN = /^[A-Za-z0-9._:/-]+$/;
const MAX_CAPTURE = 64 * 1024;
const AUTH_MARKERS = [
  "Opening authentication page in your browser",
  "Please set an Auth method",
  "Manual authorization is required",
  "Authentication consent could not be obtained",
  "Please visit the following URL to authorize"
];
const AUTH_HELP =
  "The Gemini CLI has no valid authentication. Set GEMINI_API_KEY (an AI Studio key) or use a Code Assist Standard/Enterprise license, then rerun `/gemini:setup`.";
const INELIGIBLE_MARKERS = ["IneligibleTierError", "no longer supported for Gemini Code Assist for individuals"];
const INELIGIBLE_HELP =
  "Google no longer serves personal accounts in the Gemini CLI (free, AI Pro and AI Ultra, since 2026-06-18). Use GEMINI_API_KEY (an AI Studio key), a Code Assist Standard/Enterprise license, or the default agy engine.";
const WRITE_TOOLS = new Set(["write_file", "replace", "edit", "smart_edit"]);
const VERIFICATION_RE =
  /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|playwright|cargo test|npm test|pnpm test|yarn test|go test|tsc|eslint|ruff)\b/i;

let cachedLaunch = null;

function readPackageEntry(packageJsonPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.gemini;
    if (!bin) {
      return null;
    }
    const entry = path.join(path.dirname(packageJsonPath), bin);
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

function findGeminiEntry() {
  const override = process.env.GEMINI_CLI_ENTRY;
  if (override && fs.existsSync(override)) {
    return override;
  }

  const pathDirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const entry = readPackageEntry(path.join(dir, "node_modules", "@google", "gemini-cli", "package.json"));
    if (entry) {
      return entry;
    }
  }

  const npmRoot = runCommand("npm", ["root", "-g"]);
  if (npmRoot.status === 0 && npmRoot.stdout.trim()) {
    return readPackageEntry(path.join(npmRoot.stdout.trim(), "@google", "gemini-cli", "package.json"));
  }
  return null;
}

// The Gemini CLI is a Node script. Running it straight through node avoids
// cmd.exe on Windows (8191-character limit and quoting); the prompt always goes
// through stdin.
export function resolveGeminiLaunch() {
  if (cachedLaunch) {
    return cachedLaunch;
  }
  const entry = findGeminiEntry();
  cachedLaunch = entry
    ? { command: process.execPath, prefixArgs: [entry], shell: false, entry }
    : { command: "gemini", prefixArgs: [], shell: process.platform === "win32", entry: null };
  return cachedLaunch;
}

function quoteForShell(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function buildSpawnArgs(launch, args) {
  const full = [...launch.prefixArgs, ...args];
  return launch.shell ? full.map(quoteForShell) : full;
}

function assertSafeToken(value, label) {
  if (!SAFE_TOKEN.test(String(value))) {
    throw new Error(`Invalid value for ${label}: ${value}`);
  }
}

export function getGeminiAvailability(cwd) {
  const launch = resolveGeminiLaunch();
  const result = runCommand(launch.command, buildSpawnArgs(launch, ["--version"]), {
    cwd,
    shell: launch.shell
  });
  if (result.error && result.error.code === "ENOENT") {
    return { available: false, detail: "not found (install with `npm install -g @google/gemini-cli`)" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    return { available: false, detail: result.stderr.trim() || result.stdout.trim() || `exit ${result.status}` };
  }
  const version = result.stdout.trim().split(/\r?\n/).pop() || "ok";
  return { available: true, detail: launch.entry ? `${version} (${launch.entry})` : version, version };
}

function readSelectedAuthType() {
  const settingsPath = path.join(GEMINI_HOME, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return null;
  }
  const raw = fs.readFileSync(settingsPath, "utf8");
  try {
    return JSON.parse(raw)?.security?.auth?.selectedType ?? null;
  } catch {
    return raw.match(/"selectedType"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  }
}

function hasOauthRefreshToken() {
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(GEMINI_HOME, "oauth_creds.json"), "utf8"))?.refresh_token);
  } catch {
    return false;
  }
}

// Static check only: it cannot detect an expired refresh token. probeGemini does.
export function getGeminiAuthStatus(env = process.env) {
  if (env.GEMINI_API_KEY) {
    return { loggedIn: true, method: "gemini-api-key", detail: "GEMINI_API_KEY is set" };
  }
  if (env.GOOGLE_GENAI_USE_VERTEXAI === "true") {
    return { loggedIn: true, method: "vertex-ai", detail: "Vertex AI through environment variables" };
  }

  const selectedType = readSelectedAuthType();
  if (selectedType === "oauth-personal" || env.GOOGLE_GENAI_USE_GCA === "true") {
    // Google sign-in only works with a Code Assist Standard/Enterprise license,
    // which needs a Google Cloud project; personal accounts are refused server-side.
    if (!env.GOOGLE_CLOUD_PROJECT && !env.GOOGLE_CLOUD_PROJECT_ID) {
      return {
        loggedIn: false,
        method: "oauth-personal",
        detail: "Google sign-in without a Google Cloud project: personal accounts are no longer served by the Gemini CLI; use GEMINI_API_KEY"
      };
    }
    if (hasOauthRefreshToken()) {
      return { loggedIn: true, method: "oauth-personal", detail: "Google sign-in with a Google Cloud project" };
    }
    return { loggedIn: false, method: "oauth-personal", detail: "Google sign-in selected, but no saved credentials" };
  }
  if (selectedType) {
    return { loggedIn: true, method: selectedType, detail: `method ${selectedType} (not verified)` };
  }
  return { loggedIn: false, method: null, detail: "no authentication method configured in ~/.gemini/settings.json" };
}

function shorten(text, limit = 160) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function toolTarget(params = {}) {
  return params.file_path ?? params.absolute_path ?? params.path ?? params.dir_path ?? params.directory ?? "";
}

function describeToolUse(name, params = {}) {
  switch (name) {
    case "run_shell_command":
      return `Running command: ${shorten(params.command)}`;
    case "read_file":
      return `Reading ${toolTarget(params)}`;
    case "read_many_files":
      return `Reading several files: ${shorten(JSON.stringify(params.include ?? params.paths ?? params))}`;
    case "write_file":
      return `Writing ${toolTarget(params)}`;
    case "replace":
    case "edit":
    case "smart_edit":
      return `Editing ${toolTarget(params)}`;
    case "glob":
      return `Finding files: ${shorten(params.pattern)}`;
    case "grep_search":
    case "search_file_content":
      return `Searching code: ${shorten(params.pattern)}`;
    case "list_directory":
      return `Listing ${toolTarget(params)}`;
    case "google_web_search":
      return `Searching the web: ${shorten(params.query)}`;
    case "web_fetch":
      return `Reading from the web: ${shorten(params.prompt ?? params.url)}`;
    default:
      return `Tool ${name}: ${shorten(JSON.stringify(params), 120)}`;
  }
}

function phaseForTool(name, params, write) {
  if (WRITE_TOOLS.has(name)) {
    return "editing";
  }
  if (name === "run_shell_command") {
    return VERIFICATION_RE.test(String(params?.command ?? "")) ? "verifying" : write ? "running" : "investigating";
  }
  return "investigating";
}

function gitStatusSnapshot(cwd) {
  const result = runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, shell: false });
  if (result.status !== 0) {
    return null;
  }
  return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
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
  if (!onProgress) {
    return;
  }
  onProgress(payload);
}

function containsAuthMarker(text) {
  return AUTH_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Runs one Gemini CLI turn in headless mode and returns the final answer.
 * A new session gets our own UUID (--session-id); a resumed one uses --resume <id>.
 */
export async function runGeminiTurn(cwd, options = {}) {
  const launch = resolveGeminiLaunch();
  const resumeSessionId = options.resumeSessionId ?? null;
  const sessionId = resumeSessionId ?? options.sessionId ?? randomUUID();
  const write = Boolean(options.write);
  const prompt = String(options.prompt || options.defaultPrompt || "").trim();
  if (!prompt) {
    throw new Error("Empty prompt for Gemini.");
  }

  const args = ["--output-format", "stream-json", "--skip-trust"];
  if (resumeSessionId) {
    assertSafeToken(resumeSessionId, "--resume");
    args.push("--resume", resumeSessionId);
  } else {
    args.push("--session-id", sessionId);
  }
  if (options.model) {
    assertSafeToken(options.model, "--model");
    args.push("--model", options.model);
  }
  args.push("--approval-mode", write ? "yolo" : "plan");
  args.push("--policy", write ? POLICY_WRITE : POLICY_READ_ONLY);

  const before = write ? gitStatusSnapshot(cwd) : null;
  const toolUses = new Map();
  const touched = new Set();
  const warnings = [];
  const segments = [""];
  let fullText = "";
  let stderr = "";
  let rawNonJson = "";
  let lineBuffer = "";
  let resultEvent = null;
  let model = null;
  let reportedSessionId = sessionId;
  let authRequired = false;
  let ineligible = false;
  let timedOut = false;

  emit(options.onProgress, {
    message: resumeSessionId ? `Resuming Gemini session ${resumeSessionId}.` : `Starting Gemini session ${sessionId}.`,
    phase: "starting",
    threadId: sessionId
  });

  const child = spawn(launch.command, buildSpawnArgs(launch, args), {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    shell: launch.shell,
    windowsHide: true
  });

  emit(options.onProgress, { message: "", childPid: child.pid ?? null });

  const killChild = () => {
    try {
      terminateProcessTree(child.pid ?? Number.NaN);
    } catch {
      // best effort
    }
  };

  const flushSegment = () => {
    const current = segments[segments.length - 1];
    if (current.trim()) {
      emit(options.onProgress, { message: "", logTitle: "Gemini message", logBody: current.trim() });
      segments.push("");
    }
  };

  const handleEvent = (event) => {
    switch (event.type) {
      case "init":
        reportedSessionId = event.session_id ?? reportedSessionId;
        model = event.model ?? model;
        emit(options.onProgress, {
          message: `Session ${reportedSessionId} ready${model ? ` (model ${model})` : ""}.`,
          phase: "running",
          threadId: reportedSessionId
        });
        break;
      case "message":
        if (event.role === "assistant" && typeof event.content === "string") {
          segments[segments.length - 1] += event.content;
          fullText += event.content;
        }
        break;
      case "tool_use": {
        flushSegment();
        const params = event.parameters ?? {};
        toolUses.set(event.tool_id, { name: event.tool_name, params });
        if (WRITE_TOOLS.has(event.tool_name) && toolTarget(params)) {
          touched.add(path.relative(cwd, path.resolve(cwd, toolTarget(params))) || toolTarget(params));
        }
        emit(options.onProgress, {
          message: describeToolUse(event.tool_name, params),
          phase: phaseForTool(event.tool_name, params, write)
        });
        break;
      }
      case "tool_result": {
        const tool = toolUses.get(event.tool_id);
        if (event.status === "error") {
          emit(options.onProgress, {
            message: `Tool denied or failed (${tool?.name ?? "?"}): ${shorten(event.error?.message ?? event.output, 200)}`
          });
        } else if (tool?.name === "run_shell_command") {
          emit(options.onProgress, { message: `Command finished: ${shorten(tool.params?.command)}` });
        }
        break;
      }
      case "error":
        warnings.push(String(event.message ?? ""));
        emit(options.onProgress, { message: `Gemini warning: ${shorten(event.message, 240)}` });
        break;
      case "result":
        resultEvent = event;
        flushSegment();
        emit(options.onProgress, { message: `Turn finished (${event.status ?? "?"}).`, phase: "finalizing" });
        break;
      default:
        break;
    }
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let event = null;
    if (trimmed.startsWith("{")) {
      try {
        event = JSON.parse(trimmed);
      } catch {
        event = null;
      }
    }
    if (event && typeof event.type === "string") {
      handleEvent(event);
      return;
    }
    if (rawNonJson.length < MAX_CAPTURE) {
      rawNonJson += `${trimmed}\n`;
    }
  };

  const checkAuth = (text) => {
    if (!ineligible && INELIGIBLE_MARKERS.some((marker) => text.includes(marker))) {
      ineligible = true;
    }
    if (!authRequired && containsAuthMarker(text)) {
      authRequired = true;
      emit(options.onProgress, { message: "Gemini asked for a sign-in; aborting.", phase: "failed" });
      killChild();
    }
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    lineBuffer += chunk;
    checkAuth(lineBuffer);
    let newlineIndex = lineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      handleLine(lineBuffer.slice(0, newlineIndex));
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      newlineIndex = lineBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < MAX_CAPTURE) {
      stderr += chunk;
    }
    checkAuth(chunk);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  let timer = null;
  if (options.timeoutMs && Number(options.timeoutMs) > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      emit(options.onProgress, { message: "Timeout reached; stopping Gemini.", phase: "failed" });
      killChild();
    }, Number(options.timeoutMs));
    timer.unref?.();
  }

  const exit = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
    child.on("close", (code, signal) => resolve({ code, signal, error: null }));
  });
  if (timer) {
    clearTimeout(timer);
  }
  if (lineBuffer.trim()) {
    handleLine(lineBuffer);
  }

  const finalMessage = [...segments].reverse().find((segment) => segment.trim())?.trim() ?? "";
  const after = write ? gitStatusSnapshot(cwd) : null;
  for (const file of changedFilesBetween(before, after)) {
    touched.add(file);
  }

  let errorMessage = null;
  if (exit.error) {
    errorMessage = exit.error.code === "ENOENT" ? "Gemini CLI not found. Run `/gemini:setup`." : exit.error.message;
  } else if (ineligible) {
    errorMessage = INELIGIBLE_HELP;
  } else if (authRequired || exit.code === 41) {
    errorMessage = AUTH_HELP;
  } else if (timedOut) {
    errorMessage = `Gemini exceeded the ${Math.round(Number(options.timeoutMs) / 1000)}s time limit.`;
  } else if (resultEvent?.status === "error") {
    errorMessage = resultEvent.error?.message ?? "Gemini finished with an error.";
  } else if (exit.code !== 0) {
    errorMessage =
      [stderr.trim(), rawNonJson.trim()].filter(Boolean).join("\n").slice(-4000) ||
      `Gemini exited with code ${exit.code ?? exit.signal}.`;
  }

  return {
    status: errorMessage ? (exit.code && exit.code !== 0 ? exit.code : 1) : 0,
    threadId: reportedSessionId,
    model,
    finalMessage,
    fullText: fullText.trim(),
    touchedFiles: [...touched].sort(),
    warnings,
    stats: resultEvent?.stats ?? null,
    stderr: stderr.trim(),
    error: errorMessage ? { message: errorMessage } : null,
    authRequired: authRequired || ineligible
  };
}

export async function probeGemini(cwd) {
  const result = await runGeminiTurn(cwd, {
    prompt: "Reply with exactly one word: ok",
    write: false,
    timeoutMs: 120000
  });
  if (result.status === 0) {
    return { ok: true, detail: `replied "${shorten(result.finalMessage, 40)}"${result.model ? ` (${result.model})` : ""}` };
  }
  return { ok: false, detail: result.error?.message ?? "failed", authRequired: result.authRequired };
}

export function readOutputSchema(schemaPath) {
  return fs.readFileSync(schemaPath, "utf8");
}

function extractJsonCandidate(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return fenced[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return null;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      parsed: null,
      parseError: fallback.failureMessage || "Gemini returned no final answer.",
      rawOutput: ""
    };
  }

  for (const candidate of [text, extractJsonCandidate(text)]) {
    if (!candidate) {
      continue;
    }
    try {
      return { parsed: JSON.parse(candidate), parseError: null, rawOutput: text };
    } catch {
      // try the next shape
    }
  }

  return { parsed: null, parseError: "The answer is not valid JSON.", rawOutput: text };
}
