---
name: gemini-prompting
description: Internal guidance for composing Gemini prompts for coding, review, diagnosis, and research tasks inside the Claude Code gemini plugin
user-invocable: false
---

# Prompting Gemini

Use this skill when `gemini:gemini-rescue` needs to ask Gemini for help.

Prompt Gemini like an operator, not a collaborator. Keep prompts compact and block-structured with XML tags. State the task, the output contract, the default follow-through, and the small set of extra constraints that matter.

Core rules:
- One clear task per run. Split unrelated asks into separate runs.
- Tell Gemini what done looks like. Do not assume it will infer the desired end state.
- Context first, request last: with long material (diffs, logs, files), put the material before the instruction and start the instruction with something like "Based on the material above, ...".
- Be explicit about the answer format. Gemini follows declared formats (sections, lists, JSON) well, but does not infer them.
- Add grounding and verification rules for any task where unsupported guesses would hurt quality.
- Gemini runs non-interactively: say what to do instead of asking when a low-risk detail is missing, and when to stop if a high-risk detail is missing.
- Give concrete file paths, function names and test commands when Claude already knows them. That saves Gemini's exploration.

Default prompt recipe:
- `<context>`: the supporting material (snippets, error, diff), when there is any.
- `<task>`: the concrete job and its scope.
- `<output_contract>`: exact shape, ordering, and length of the answer.
- `<default_follow_through>`: what to do instead of asking.
- `<verification>`: required for debugging, implementation, or risky fixes (which tests or commands to run and what counts as success).
- `<grounding>`: required for review and research (cite file and line, separate fact from inference).
- `<action_safety>`: for write-capable tasks, to keep Gemini in scope and away from unrequested refactors.

How to choose the prompt shape:
- Use the built-in `review` or `adversarial-review` commands when the job is reviewing local git changes; those prompts already carry the review contract.
- Use `task` for diagnosis, planning, research, or implementation when you need to control the prompt directly.
- Use `task --resume-last` for follow-up instructions in the same session. Send only the delta instruction instead of restating the whole prompt unless the direction changed materially.

Prompt assembly checklist:
1. Define the exact task and scope in `<task>`.
2. Choose the smallest output contract that still makes the answer easy to use.
3. Decide whether Gemini should keep going by default or stop for missing high-risk details.
4. Add verification, grounding, and safety blocks only where the task needs them.
5. Remove redundant instructions before sending the prompt.

Example implementation prompt:

```xml
<task>
Fix the due-date calculation in src/billing/due-date.ts: installments that fall on a weekend must move to the next business day.
Scope: that file and its test only.
</task>
<verification>
Run `npx vitest run src/billing/due-date.test.ts`. Done = tests pass, including new cases for Saturday and Sunday.
</verification>
<action_safety>
Do not refactor anything outside the scope. Do not change public signatures.
</action_safety>
<output_contract>
Reply with: root cause, change made, touched files, test command and result.
</output_contract>
```
