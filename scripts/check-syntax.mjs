// Runs `node --check` on every JavaScript file the plugins ship.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = path.join(root, "plugins");

function collect(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "types") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collect(full));
    } else if (/\.(mjs|cjs|js)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

let failed = 0;
for (const file of collect(pluginsDir)) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failed += 1;
    process.stderr.write(`${path.relative(root, file)}\n${result.stderr}\n`);
  }
}

if (failed > 0) {
  process.stderr.write(`${failed} file(s) failed the syntax check.\n`);
  process.exit(1);
}
console.log("Syntax check passed.");
