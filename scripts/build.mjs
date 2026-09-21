import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const root = resolve(".");
const outArg = process.argv[2] || process.env.BUILD_OUT;
if (!outArg) throw new Error("Build output path is required");
const out = resolve(outArg);
await rm(out, { recursive: true, force: true });
await mkdir(join(out, "server"), { recursive: true });
await mkdir(join(out, ".openai", "drizzle"), { recursive: true });
await cp(join(root, "worker"), join(out, "server"), { recursive: true });
await cp(join(root, "drizzle"), join(out, ".openai", "drizzle"), { recursive: true });
const manifest = JSON.parse(await readFile(join(root, ".openai", "hosting.json"), "utf8"));
await writeFile(join(out, ".openai", "hosting.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Built ${out}`);
