# Changelog

## 0.1.2 - 2026-10-07

- New `GEMINI_COMPANION_LANGUAGE` setting (for example `pt-BR`): Gemini writes its answers, task reports,
  review findings and the stop-gate reason in that language. JSON keys and the `verdict` and `severity`
  values stay as the schema defines them, and the stop gate keeps its `ALLOW:`/`BLOCK:` prefix. Values
  are validated, so the setting cannot inject prompt text. Unset, nothing changes.
- `/gemini:setup` shows the response language.

## 0.1.1 - 2026-10-07

- Fix: on Windows, `/gemini:cancel` and `--timeout-minutes` did not stop Gemini when the companion ran
  from Git Bash (as Claude Code's Bash tool does). The shell rewrote taskkill's `/PID`, `/T` and `/F`
  flags into file paths; taskkill now runs without a shell. The same code exists in the Codex plugin
  this project is based on.
- Fix: on macOS and Linux, a `--timeout-minutes` run could leave the engine running, because the
  engine is not a process-group leader and the group signal failed without falling back to the process.
- `/gemini:cancel` now confirms that the processes are gone, retries once, and reports `engineStopped`.
- Docs: status, known limitations and troubleshooting sections in the README; `npm run smoke` end-to-end test.

## 0.1.0 - 2026-10-07

First public release.

- `gemini` plugin: `/gemini:setup`, `/gemini:rescue`, `/gemini:review`, `/gemini:adversarial-review`,
  `/gemini:status`, `/gemini:result` and `/gemini:cancel`, a forwarding subagent, a Node companion with
  foreground and background jobs, session hooks and an optional stop-time review gate.
- Default engine: the Antigravity CLI (`agy`) in headless `stream-json` mode, with `--json-schema` for
  reviews and `--conversation` for resume. The Gemini CLI stays available through
  `GEMINI_COMPANION_ENGINE=gemini-cli` for API key, Vertex AI and Code Assist license users.
- `claude-companion-guard`: a PreToolUse guard installed into agy that only acts on companion runs and
  enforces the read-only and write policies.
- `gemini-monitor` mod: live pane (`/gemini-panel`), status line, notifications and a wake-up prompt for
  background jobs (`/gemini-wake`).
- Tests: guard and companion unit tests (`npm test`) and an end-to-end smoke test (`npm run smoke`).
