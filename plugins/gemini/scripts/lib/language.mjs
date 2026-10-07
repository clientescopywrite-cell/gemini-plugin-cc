// Response language for Gemini, set with GEMINI_COMPANION_LANGUAGE (for example
// "pt-BR" or "Spanish"). Unset, Gemini follows the language of the request.
const LANGUAGE_ENV = "GEMINI_COMPANION_LANGUAGE";
const SAFE_LANGUAGE = /^[\p{L}\p{N} ()_-]{2,40}$/u;

export function resolveResponseLanguage(env = process.env) {
  const value = String(env[LANGUAGE_ENV] ?? "").trim();
  if (!value) {
    return null;
  }
  if (!SAFE_LANGUAGE.test(value)) {
    throw new Error(`Invalid ${LANGUAGE_ENV} "${value}". Use a language name or tag such as pt-BR, es or Japanese.`);
  }
  return value;
}

// Rule for the human-readable fields of a review (summary, findings, next steps).
export function reviewLanguageRule(language) {
  if (language) {
    return `Write \`summary\`, \`title\`, \`body\`, \`recommendation\` and \`next_steps\` in ${language}. Keep the JSON keys and the \`verdict\` and \`severity\` values exactly as the schema defines them.`;
  }
  return "Write `summary`, `title`, `body`, `recommendation` and `next_steps` in the same language as the user focus when it is given, otherwise in English.";
}

// Line added to task preambles; null when the language follows the request.
export function taskLanguageRule(language) {
  return language ? `Write your answers and your final report in ${language}.` : null;
}

// Rule for the stop-time review gate, whose first line is parsed by the hook.
export function stopGateLanguageRule(language) {
  return language
    ? `Keep the ALLOW: or BLOCK: prefix in English, and write the reason and anything after it in ${language}.`
    : "";
}
