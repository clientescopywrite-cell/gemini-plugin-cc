# Gemini plugin for Claude Code

Use Gemini from inside Claude Code to review code or to delegate tasks, the same way the
[Codex plugin](https://github.com/openai/codex-plugin-cc) does for Codex. Claude orchestrates
and reviews; Gemini does the work in the background or in the foreground, and you can follow it live.

> Unofficial community project. Not affiliated with Google, Anthropic or OpenAI.

## What you get

- `/gemini:review`: a read-only Gemini code review of your uncommitted changes or of your branch.
- `/gemini:adversarial-review`: a review that tries to break the change and questions its design.
- `/gemini:rescue`: hand a bug, an investigation or an implementation to Gemini (write access by default, `--read-only` to only investigate).
- `/gemini:status`, `/gemini:result`, `/gemini:cancel`: manage jobs, including background ones.
- `/gemini:setup`: check the engine, install the safety guard, run a live probe, and toggle the optional stop-time review gate.
- The optional `gemini-monitor` mod: a live pane (`/gemini-panel`), a status line with the running job, a notification when a job finishes and, for background jobs, a prompt that wakes Claude up to review the result.

## Why the Antigravity CLI

Since June 18, 2026 the Gemini CLI no longer serves personal Google accounts (free, Google AI Pro
and Google AI Ultra). Google's successor for individual users is the **Antigravity CLI (`agy`)**, so
that is this plugin's default engine: it runs with the Google account you sign in with.

If you have a Gemini API key, Vertex AI or a Gemini Code Assist Standard/Enterprise license, you can
use the Gemini CLI instead by setting `GEMINI_COMPANION_ENGINE=gemini-cli`.

## Requirements

- Claude Code (the `gemini-monitor` mod needs Claude Code 2.1.291 or later).
- Node.js 18.18 or later.
- The Antigravity CLI, signed in once interactively: see the
  [official install guide](https://antigravity.google/docs/getting-started?tab=cli).
- Git, for reviews.

Tested on Windows with agy 1.3.1. macOS and Linux should work but have not been tested yet.

## Install

```text
/plugin marketplace add clientescopywrite-cell/gemini-plugin-cc
/plugin install gemini@gemini-plugin-cc
/plugin install gemini-monitor@gemini-plugin-cc   # optional
```

Then run:

```text
/gemini:setup
```

Setup checks agy, installs the guard, adds its permission rules, and runs a short live probe. If agy
is not signed in yet, `/gemini:setup --login` opens a window running `agy` (on Windows) where you can sign in.

## Typical flows

- Review before you ship: `/gemini:review`, or `/gemini:adversarial-review focus: retries and empty input`.
- Hand off a problem: `/gemini:rescue the export job fails on empty months, find and fix the cause`.
- Long task: `/gemini:rescue --background ...`, then `/gemini:status` or the `/gemini-panel` pane.
- Follow up on the same Gemini conversation: `/gemini:rescue --resume apply the top fix`.

Options for `rescue` and the reviews: `--model pro|flash|<name from agy models>` and
`--effort low|medium|high|xhigh|max`.

## How it works

Each run goes through a small Node companion (`plugins/gemini/scripts/gemini-companion.mjs`) that:

1. starts `agy` in headless mode with `stream-json` input and output (`--mode plan` for read-only
   runs, `--mode accept-edits` for write runs, `--json-schema` for reviews);
2. turns the event stream into a job log, so `/gemini:status` and the monitor can show progress;
3. keeps job state under `~/.claude/gemini-companion/` and the conversation id, so `--resume` continues
   the same Gemini conversation.

## Safety

Headless agy cannot ask you for permission, so the plugin installs a small PreToolUse guard into agy
(`plugins/gemini/agy-plugins/claude-companion-guard`). It only acts on runs started by the companion
(it reads `GEMINI_COMPANION_POLICY`) and prints nothing otherwise, so your normal `agy` sessions are untouched.

- Read-only runs: no edits; only read commands (`git status/diff/log/show`, `ls`, `cat`, `rg`).
- Write runs: edits inside the repository; commands from `allowlist.json` only (read-only commands,
  tests, lint, typecheck, build, `git add`, `git commit`), one at a time.
- Always blocked: push, branch switching, merge, rebase, reset, edits under `.git/`, remote access
  (ssh, scp), containers and infrastructure, direct database access and migrations, the GitHub CLI,
  package publishing, and reading or writing outside the repository.
- Blocked calls get a reason back, so Gemini continues and reports what it could not do.

Setup also adds one `permissions.allow` rule per allowlist entry to `~/.gemini/antigravity-cli/settings.json`
(headless agy needs them to run those commands). These rules also apply when you use `agy` directly.
The plugin never uses `--dangerously-skip-permissions`.

This is defense in depth, not a sandbox: for write tasks on important repositories, run them in an
isolated git worktree and review the diff before you commit or push.

## Configuration

| Variable | Effect |
| --- | --- |
| `GEMINI_COMPANION_ENGINE=gemini-cli` | Use the Gemini CLI (API key, Vertex AI or Code Assist license) instead of agy. |
| `GEMINI_COMPANION_HOME` | Where job state lives (default `~/.claude/gemini-companion`). |
| `GEMINI_CLI_ENTRY` | Path to the Gemini CLI entry script, when it is not found automatically. |

## Uninstall

```text
/plugin uninstall gemini@gemini-plugin-cc
/plugin uninstall gemini-monitor@gemini-plugin-cc
```

Then run `agy plugin uninstall claude-companion-guard` and remove the `command(regex:...)` rules
from `~/.gemini/antigravity-cli/settings.json`.

## Development

```bash
npm test   # syntax check + guard and companion tests
```

## Maintainers

Maintained by [CopyWrite](https://www.copywritecorp.com.br), a Brazilian studio for websites, systems,
automation and paid traffic. Issues and pull requests are welcome.

## License

Apache-2.0. Parts of this project are adapted from
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0); see `NOTICE`.
