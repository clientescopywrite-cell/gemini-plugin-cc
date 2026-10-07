// PreToolUse guard of the Claude Code gemini plugin for the Antigravity CLI (agy).
//
// It only acts when agy was started by the companion, which sets
// GEMINI_COMPANION_POLICY=read-only|write. Otherwise it prints nothing: empty
// output is agy's only neutral hook answer ({} or an empty decision count as a deny).
//
// Headless agy cannot ask for permission (it denies and ends the turn with no
// answer), so the guard denies first, with a reason, everything that is not
// allowed; the agent reads the reason and keeps going. What allowlist.json lists
// passes through and is approved by the permissions.allow rules that
// `/gemini:setup` writes to agy's settings.json.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const policy = process.env.GEMINI_COMPANION_POLICY || "";
const allowlist = JSON.parse(fs.readFileSync(path.join(__dirname, "allowlist.json"), "utf8"));

function reply(value) {
  process.stdout.write(JSON.stringify(value));
}

function deny(reason) {
  reply({ decision: "deny", reason: `Blocked by the Claude Code gemini plugin: ${reason}` });
}

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

const WRITE_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "sed_file",
  "notebook_edit",
  "notebook_execution",
  "delete_knowledge"
]);
// Tools that headless runs cannot approve or that act outside the repository.
const BLOCKED_TOOLS = new Map([
  ["send_message", "sends messages outside the repository"],
  ["schedule", "schedules runs"],
  ["manage_inbox", "changes the inbox"],
  ["manage_task", "changes external tasks"],
  ["run_workflow", "runs external workflows"],
  ["send_command_input", "drives running processes"],
  ["call_mcp_tool", "calls MCP servers"],
  ["read_url_content", "reads web pages (use web search instead)"],
  ["open_browser_url", "opens the browser"],
  ["browser_subagent", "drives the browser"],
  ["execute_browser_javascript", "drives the browser"]
]);

const DANGEROUS_COMMANDS = [
  [
    /\bgit\s+(-C\s+\S+\s+)?(push|remote|reset|clean|checkout|switch|restore|stash|rebase|merge|cherry-pick|revert|tag|filter-branch|filter-repo|update-ref|config|gc|reflog|submodule|worktree)\b/i,
    "a Git command that publishes, switches branches, rewrites history or discards work"
  ],
  [/\bgit\s+(-C\s+\S+\s+)?branch\s+(-d|-D|--delete|-m|-M)\b/i, "deleting or renaming a branch"],
  [/(^|[\s;&|(])(ssh|scp|sftp|rsync|plink|pscp)(\.exe)?\b/i, "remote access"],
  [/(^|[\s;&|(])(docker|docker-compose|podman|kubectl|helm|terraform)(\.exe)?\b/i, "infrastructure"],
  [/(^|[\s;&|(])(psql|mysql|mongosh)(\.exe)?\b/i, "direct database access"],
  [/\bprisma\s+(migrate|db)\b/i, "database schema or data changes"],
  [/\b(npm|pnpm|yarn)\s+publish\b/i, "package publishing"],
  [/(^|[\s;&|(])gh(\.exe)?\s+/i, "the GitHub CLI"]
];

function prefixPattern(prefix) {
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "i");
}

const READ_ONLY = allowlist.readOnly.map(prefixPattern);
const DEV = allowlist.dev.map(prefixPattern);

function commandOf(args = {}) {
  return String(args.CommandLine ?? args.commandLine ?? args.Command ?? args.command ?? "").trim();
}

function isCompound(command) {
  return /&&|\|\||[;|<>`]|\$\(|\r|\n/.test(command.replace(/2>&1/g, ""));
}

function pathsIn(args = {}) {
  return Object.entries(args)
    .filter(([key, value]) => typeof value === "string" && /(file|path|target|dir)/i.test(key))
    .map(([, value]) => value);
}

function insideWorkspace(filePath, workspaces) {
  if (!path.isAbsolute(filePath)) {
    return true;
  }
  const resolved = path.resolve(filePath).toLowerCase();
  return workspaces.some((root) => {
    const base = path.resolve(root).toLowerCase();
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

// Reading outside the repository (and outside agy's own folder) is not allowed.
const AGENT_HOME = path.join(os.homedir(), ".gemini", "antigravity-cli");
const READ_TOOLS = new Set(["view_file", "list_dir", "find_by_name", "grep_search"]);

function outsideAllowedRoots(filePath, workspaces) {
  if (/(^|[\\/])\.\.([\\/]|$)/.test(filePath)) {
    return true;
  }
  return path.isAbsolute(filePath) && !insideWorkspace(filePath, [...workspaces, AGENT_HOME]);
}

function commandPathTokens(command) {
  return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter((token) => /^([a-z]:[\\/]|[\\/]|~)/i.test(token) || /(^|[\\/])\.\.([\\/]|$)/.test(token))
    .map((token) => token.replace(/^~/, os.homedir()));
}

function checkCommand(command, allowed, listLabel, workspaces) {
  if (!command) {
    deny("empty command.");
    return;
  }
  const outside = workspaces.length > 0 ? commandPathTokens(command).find((token) => outsideAllowedRoots(token, workspaces)) : null;
  if (outside) {
    deny(`${outside} is outside the repository. Work inside it only.`);
    return;
  }
  for (const [pattern, label] of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) {
      deny(`${label}. Only make local edits and commits; Claude handles the rest.`);
      return;
    }
  }
  if (isCompound(command)) {
    deny("run one command at a time, without &&, ;, pipes, redirection or subshells.");
    return;
  }
  if (!allowed.some((pattern) => pattern.test(command))) {
    deny(`command not in the allowed list (${listLabel}). Do not stop: continue without it and, in your final report, say which command you would have needed and why.`);
    return;
  }
  // Allowed: no answer, so agy's permissions.allow rule approves it.
}

function main() {
  const input = readInput();
  if (policy !== "read-only" && policy !== "write") {
    return;
  }

  const name = String(input.toolCall?.name ?? "");
  const args = input.toolCall?.args ?? {};
  const workspaces = Array.isArray(input.workspacePaths) ? input.workspacePaths : [];

  if (BLOCKED_TOOLS.has(name)) {
    deny(`${name} ${BLOCKED_TOOLS.get(name)} and is not allowed in this run. Continue without it.`);
    return;
  }

  if (READ_TOOLS.has(name) && workspaces.length > 0) {
    const outside = pathsIn(args).find((filePath) => outsideAllowedRoots(filePath, workspaces));
    if (outside) {
      deny(`${outside} is outside the repository. Work inside it only.`);
    }
    return;
  }

  // agy's own artifacts (plans and notes under ~/.gemini/antigravity-cli/brain) are free to write.
  if (WRITE_TOOLS.has(name)) {
    const targets = pathsIn(args);
    if (targets.length > 0 && targets.every((filePath) => path.isAbsolute(filePath) && insideWorkspace(filePath, [AGENT_HOME]))) {
      return;
    }
  }

  if (policy === "read-only") {
    if (WRITE_TOOLS.has(name)) {
      deny("this is a read-only run; do not edit files, only investigate and answer.");
      return;
    }
    if (name === "run_command") {
      checkCommand(commandOf(args), READ_ONLY, "read-only: git status/diff/log/show, ls, cat, rg", workspaces);
    }
    return;
  }

  if (name === "run_command") {
    checkCommand(commandOf(args), [...READ_ONLY, ...DEV], "read-only, tests, lint, typecheck, build, git add and git commit", workspaces);
    return;
  }
  if (WRITE_TOOLS.has(name)) {
    const targets = pathsIn(args);
    // Editing .git/ directly would bypass the Git blocks (for example git config).
    const gitInternal = targets.find((filePath) => /(^|[\\/])\.git([\\/]|$)/i.test(filePath));
    if (gitInternal) {
      deny(`${gitInternal} is Git-internal and cannot be edited; leave repository configuration to Claude.`);
      return;
    }
    const outside = workspaces.length > 0 ? targets.find((filePath) => !insideWorkspace(filePath, workspaces)) : null;
    if (outside) {
      deny(`${outside} is outside the workspace.`);
    }
  }
}

main();
