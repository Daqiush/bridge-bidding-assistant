import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const source = await readFile("dist/server/index.js", "utf8");
const manifest = await readFile("dist/.openai/hosting.json", "utf8");
JSON.parse(manifest);
const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
assert.equal(typeof mod.default?.fetch, "function");
console.log("Artifact is valid ESM and exports default.fetch");
