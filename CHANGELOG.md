# Changelog

## 0.1.1 - 2026-10-07

- Fix: on Windows, `/gemini:cancel` and `--timeout-minutes` did not stop Gemini when the companion ran
  from Git Bash (as Claude Code's Bash tool does). The shell rewrote taskkill's `/PID`, `/T` and `/F`
  flags into file paths; taskkill now runs without a shell. The same code exists in the Codex plugin
  this project is based on.
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
