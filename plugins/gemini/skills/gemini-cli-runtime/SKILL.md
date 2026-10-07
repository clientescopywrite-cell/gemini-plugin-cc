---
name: gemini-cli-runtime
description: Internal helper contract for calling the gemini-companion runtime from Claude Code
user-invocable: false
---

# Gemini Runtime

Use this skill only inside the `gemini:gemini-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `agy` calls, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `gemini:gemini-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gemini-prompting` skill to rewrite the user's request into a tighter Gemini prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave model and effort unset by default. Add `--model` or `--effort` only when the user explicitly asks.
- Default to a write-capable run by adding `--write` unless the user asks for read-only behavior or only wants review, diagnosis, or research without edits.

How the runtime runs Gemini:
- Default engine: the Antigravity CLI (`agy`), signed in with the user's Google account. Since 2026-06-18 the Gemini CLI no longer serves personal accounts; it only runs with `GEMINI_COMPANION_ENGINE=gemini-cli` plus `GEMINI_API_KEY`.
- Headless mode with `stream-json` input and output; each new task opens a conversation and resuming uses `--conversation <id>`.
- Read-only runs use `--mode plan`. Write runs use `--mode accept-edits` (edits inside the repository are allowed).
- The `claude-companion-guard` guard (installed into agy by setup) only acts on companion runs: it blocks push, branch switching, history rewrites, edits under `.git/`, remote access, infrastructure, databases, reads and writes outside the repository, and commands outside the allowed list (read-only, tests, lint, typecheck, build, `git add`, `git commit`), always one command at a time. Gemini receives the reason for each block and keeps going.
- Reviews use `--json-schema`, so the verdict comes back structured.
- Every new task gets a short preamble with these rules and asks for a final report (what was done, touched files, verification, pending items). `--raw` turns the preamble off.
- When `GEMINI_COMPANION_LANGUAGE` is set (for example `pt-BR`), the preamble and the review prompts ask Gemini to answer in that language; do not add language instructions to the forwarded text yourself.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat it as Claude-side execution control: forward `--background` to `task`; strip `--wait`.
- `--model`: `pro` (gemini-3.1-pro-high), `flash` (gemini-3.8-flash-high), or a full name from `agy models`.
- `--effort`: `low`, `medium`, `high`, `xhigh` or `max`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- If the forwarded request includes `--read-only`, strip that token from the task text and do not add `--write`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `task --resume-last`: for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.
- Long prompts or prompts with quotes: write them to a temporary file and use `--prompt-file <path>`.

Safety rules:
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, or summarize output.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Gemini cannot be invoked, return nothing.
