---
description: Check whether the Gemini engine (Antigravity CLI) is ready, install the guard and permissions, run a live probe, and toggle the stop-time review gate
argument-hint: '[--login] [--enable-review-gate|--disable-review-gate] [--skip-probe]'
allowed-tools: Bash(node:*), Bash(powershell:*), AskUserQuestion
---

Run (timeout 300000 ms):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json $ARGUMENTS
```

Setup is idempotent: it installs or updates the `claude-companion-guard` guard inside agy and the `permissions.allow` rules in `~/.gemini/antigravity-cli/settings.json`, then runs a short live probe.

If the result says the engine (agy) is not installed:
- Use `AskUserQuestion` exactly once to ask whether Claude should install it now.
- Options: `Install the Antigravity CLI (Recommended)` and `Skip for now`.
- If the user chooses to install, follow the official instructions at https://antigravity.google/docs/getting-started?tab=cli. On Windows, download `https://antigravity.google/cli/install.ps1` to a temporary folder, read it before running it, then run:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File <path to the downloaded install.ps1>
```

- Then run setup again.

If the engine is installed but the live probe fails because of sign-in (or agy was never opened) and `$ARGUMENTS` does not include `--login`:
- Use `AskUserQuestion` exactly once with the options `Sign in now (Recommended)` and `Skip for now`.
- If the user chooses to sign in, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json --login
```

- On Windows this opens a PowerShell window running `agy`; elsewhere it prints the command to run. Tell the user to sign in there and to let you know when done; then run setup again.

Output rules:
- Present the final setup result to the user as short bullets: engine, sign-in, live probe, policies, review gate and next steps.
- If setup added rules to agy's settings or installed the guard, say so in one line.
- If installation or sign-in was skipped, present the original setup output.
