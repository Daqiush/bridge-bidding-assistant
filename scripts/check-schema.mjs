import { readFile } from "node:fs/promises";
const sql = await readFile("drizzle/0000_dataset.sql", "utf8");
for (const name of ["bidding_rules", "dataset_state", "dataset_generations", "dataset_imports", "explanation_cache", "rate_limit_buckets"]) {
  if (!sql.includes(`CREATE TABLE IF NOT EXISTS ${name}`)) throw new Error(`missing table ${name}`);
}
console.log("Schema migration is present");
