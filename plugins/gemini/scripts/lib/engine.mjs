import fs from "node:fs";

import * as agy from "./agy.mjs";
import * as geminiCli from "./gemini.mjs";

// The plugin's engine. Default: the Antigravity CLI (agy), which serves
// personal Google accounts. Alternative: GEMINI_COMPANION_ENGINE=gemini-cli,
// which needs GEMINI_API_KEY, Vertex AI or a Code Assist Standard/Enterprise
// license (since 2026-06-18 the Gemini CLI refuses personal accounts).
const useGeminiCli = process.env.GEMINI_COMPANION_ENGINE === "gemini-cli";

export const ENGINE = useGeminiCli ? "gemini-cli" : "agy";
export const ENGINE_LABEL = useGeminiCli ? "Gemini CLI (API key)" : agy.ENGINE_LABEL;
export const DEFAULT_CONTINUE_PROMPT = agy.DEFAULT_CONTINUE_PROMPT;
export const { parseStructuredOutput, readOutputSchema } = geminiCli;

export function getEngineAvailability(cwd) {
  return useGeminiCli ? geminiCli.getGeminiAvailability(cwd) : agy.getEngineAvailability(cwd);
}

export function getEngineAuthStatus() {
  return useGeminiCli ? geminiCli.getGeminiAuthStatus() : agy.getEngineAuthStatus();
}

export function getEnginePolicyStatus() {
  if (!useGeminiCli) {
    return agy.getEnginePolicyStatus();
  }
  const missing = [geminiCli.POLICY_READ_ONLY, geminiCli.POLICY_WRITE].filter((file) => !fs.existsSync(file));
  return { ok: missing.length === 0, detail: missing.length === 0 ? "Gemini CLI policies ok" : `missing ${missing.join(", ")}` };
}

export function ensureEnginePolicy() {
  return useGeminiCli ? [] : agy.ensureEnginePolicy();
}

export function openLoginWindow() {
  if (useGeminiCli) {
    return { opened: false, detail: "With the Gemini CLI engine, set GEMINI_API_KEY (an AI Studio key); personal Google sign-in no longer works." };
  }
  return agy.openLoginWindow();
}

export async function runEngineTurn(cwd, options = {}) {
  if (!useGeminiCli) {
    return agy.runEngineTurn(cwd, options);
  }
  // The Gemini CLI has no effort flag and no enforced schema; the review prompt already carries the schema.
  const { effort, jsonSchemaPath, ...rest } = options;
  const result = await geminiCli.runGeminiTurn(cwd, rest);
  return { ...result, structuredOutput: null };
}

export async function probeEngine(cwd) {
  return useGeminiCli ? geminiCli.probeGemini(cwd) : agy.probeEngine(cwd);
}
