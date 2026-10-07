// Pure helpers of the companion: argument parsing, structured-output parsing and rendering.
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgs, splitRawArgumentString } from "../plugins/gemini/scripts/lib/args.mjs";
import { parseStructuredOutput } from "../plugins/gemini/scripts/lib/gemini.mjs";
import { renderReviewResult } from "../plugins/gemini/scripts/lib/render.mjs";

test("raw slash-command arguments split like a shell would", () => {
  const tokens = splitRawArgumentString(`--background --model pro "fix the 'login' bug"`);
  assert.deepEqual(tokens, ["--background", "--model", "pro", "fix the 'login' bug"]);
  const { options, positionals } = parseArgs(tokens, { valueOptions: ["model"], booleanOptions: ["background"] });
  assert.equal(options.model, "pro");
  assert.equal(options.background, true);
  assert.deepEqual(positionals, ["fix the 'login' bug"]);
});

test("structured output is read from plain JSON, fenced JSON or surrounding text", () => {
  const value = { verdict: "approve", summary: "ok", findings: [], next_steps: [] };
  assert.deepEqual(parseStructuredOutput(JSON.stringify(value)).parsed, value);
  assert.deepEqual(parseStructuredOutput("```json\n" + JSON.stringify(value) + "\n```").parsed, value);
  assert.deepEqual(parseStructuredOutput(`Here it is: ${JSON.stringify(value)} done`).parsed, value);
  assert.equal(parseStructuredOutput("not json").parsed, null);
});

test("review findings render ordered by severity", () => {
  const rendered = renderReviewResult(
    {
      parsed: {
        verdict: "needs-attention",
        summary: "Do not ship.",
        findings: [
          { severity: "low", title: "Minor", body: "b", file: "a.js", line_start: 1, line_end: 1, confidence: 0.4, recommendation: "r" },
          { severity: "critical", title: "Data loss", body: "b", file: "b.js", line_start: 9, line_end: 12, confidence: 0.9, recommendation: "r" }
        ],
        next_steps: ["Fix it"]
      }
    },
    { reviewLabel: "Adversarial Review", targetLabel: "working tree diff" }
  );
  assert.ok(rendered.indexOf("Data loss") < rendered.indexOf("Minor"));
  assert.match(rendered, /b\.js:9-12/);
  assert.match(rendered, /Verdict: needs-attention/);
});
