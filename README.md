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

## Status

Early release (0.1.2). Verified on 2026-10-07 on Windows 10 with Claude Code 2.1.291, the Antigravity
CLI 1.3.1 and Node.js 22:

- installed from this marketplace into a clean Claude Code configuration;
- `/gemini:status` and `/gemini:rescue` end to end through Claude Code (command, subagent, companion, agy);
- the smoke test (`npm run smoke`): setup with a live probe, read-only tasks, two background jobs in
  parallel, a write task that fixes a bug and runs `npm test`, resume, both reviews, cancel, timeout and
  the stop-time review gate.

Typical durations across three runs on that machine (they vary with Gemini's load): 30 to 55 seconds
for a small read-only task, 45 to 70 seconds for a write task that also runs the tests, 1 to 2.5 minutes
for a review. Cancel and timeouts stop the engine within a few seconds.

Not verified yet: macOS and Linux, and the Gemini CLI engine with a real API key (only its error path
was tested).

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

Set these in the `env` block of your Claude Code settings (`~/.claude/settings.json`) so every
command picks them up, for example `"env": { "GEMINI_COMPANION_LANGUAGE": "pt-BR" }`.

| Variable | Effect |
| --- | --- |
| `GEMINI_COMPANION_ENGINE=gemini-cli` | Use the Gemini CLI (API key, Vertex AI or Code Assist license) instead of agy. |
| `GEMINI_COMPANION_LANGUAGE` | Language for Gemini's answers, reports and review findings (for example `pt-BR`). Unset, Gemini follows the language of each request, and reviews without focus text come back in English. |
| `GEMINI_COMPANION_HOME` | Where job state lives (default `~/.claude/gemini-companion`). |
| `GEMINI_CLI_ENTRY` | Path to the Gemini CLI entry script, when it is not found automatically. |

## Known limitations

- Commands outside the allowlist (for example `node -e`, `curl` or project scripts other than test,
  lint, build and typecheck) are blocked; Gemini says in its report what it would have needed to run.
- Gemini runs one shell command at a time; chains with `&&`, `;`, pipes or redirection are blocked.
- The `permissions.allow` rules that setup adds also apply to your interactive `agy` sessions.
- `/gemini:status` inside a Claude session only lists the jobs started from that session, and ending
  the session removes them from the list (same behavior as the Codex plugin).
- The `pro` and `flash` model aliases point to the current agy model names; run `agy models` for the full list.
- Command labels (status tables, setup report) are in English. Gemini's own answers follow
  `GEMINI_COMPANION_LANGUAGE` when it is set, or the language of each request.
- The `gemini-monitor` mod uses Claude Code's early-access function hooks, which may change between releases.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `agy returned no answer: ... headless mode cannot prompt` | A command needed a permission rule that is missing. Run `/gemini:setup` to restore the rules. |
| `agy` ignores the permission rules | `~/.gemini/antigravity-cli/settings.json` must be saved without a byte-order mark (BOM); agy falls back to defaults otherwise. |
| `/gemini:setup` reports agy is not signed in | Run `/gemini:setup --login` (or `agy` in a terminal) and sign in once. |
| A job shows as orphaned in `/gemini:status` | Its worker process ended without recording a result (reboot or external kill). Start it again. |
| On Windows, `/gemini:cancel` or a timeout leaves Gemini running | Update to 0.1.1 or later (`/plugin marketplace update gemini-plugin-cc`); older versions sent taskkill through Git Bash, which broke its flags. |
| `/plugin marketplace add` fails with `Filename too long` on Windows | The Claude Code config folder path is too long for Git; use a shorter path or enable `git config --global core.longpaths true`. |

## Uninstall

```text
/plugin uninstall gemini@gemini-plugin-cc
/plugin uninstall gemini-monitor@gemini-plugin-cc
```

Then run `agy plugin uninstall claude-companion-guard` and remove the `command(regex:...)` rules
from `~/.gemini/antigravity-cli/settings.json`.

## Development

```bash
npm test        # syntax check + guard and companion tests (no network)
npm run smoke   # end-to-end checks against the real engine; needs a signed-in agy and uses your Gemini quota
```

See `CHANGELOG.md` for the release history.

## Maintainers

Maintained by [CopyWrite](https://www.copywritecorp.com.br), a Brazilian studio for websites, systems,
automation and paid traffic. Issues and pull requests are welcome.

## License

Apache-2.0. Parts of this project are adapted from
[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0); see `NOTICE`.
