import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

test("build artifact declares D1/R2 and a bundled Worker", async () => {
  const root = resolve(".");
  const out = await mkdtemp(join(tmpdir(), "bridge-build-"));
  await exec(process.execPath, [resolve(root, "scripts/build.mjs"), out], { cwd: root });
  assert.equal(existsSync(resolve(root, "scripts/build.mjs")), true);
  assert.equal(existsSync(resolve(out, "server/index.js")), true);
  const manifest = JSON.parse(await readFile(resolve(out, ".openai/hosting.json"), "utf8"));
  assert.equal(manifest.d1, "DB");
  assert.equal(manifest.r2, "STAGING");
  assert.equal(existsSync(resolve(out, ".openai/drizzle")), true);
});
