---
description: Run a Gemini code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <pro|flash|name>] [--effort <low|medium|high|xhigh|max>] [optional focus]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Gemini review through the plugin companion.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Gemini's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself: the companion ignores them; Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- Text after the flags becomes the review focus.
- For a review that challenges the design and assumptions, the user should use `/gemini:adversarial-review`.

Foreground flow:
- Run (timeout 600000 ms):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "$ARGUMENTS"`,
  description: "Gemini review",
  run_in_background: true
})
```
- Do not wait for completion in this turn.
- After launching the command, tell the user: "Gemini review started in the background. Check `/gemini:status` for progress."
