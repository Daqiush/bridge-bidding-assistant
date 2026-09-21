# TXT 叫牌数据库与访客触发更新 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把原 App 的四套 ZIP/TXT 规则导入托管数据库，每六小时由首位访客触发可续跑更新，并让下一步建议显示真实解释、点击后推进叫牌。

**Architecture:** Cloudflare Worker 用 D1 保存版本化规则、更新游标、解释缓存和限流桶，用 R2 仅暂存导入中的 ZIP/TXT。每个请求最多推进一个带 fencing token 的有界步骤；四体系全部校验后原子切换 active generation，查询按 D1 → 缓存 → `/bidcomment` 兜底。页面用完整上下文隔离旧结果，并通过状态轮询继续导入任务。

**Tech Stack:** Cloudflare Workers ESM、D1/SQLite、R2、Drizzle migrations、fflate、esbuild、Miniflare、原生 HTML/CSS/JavaScript、Node.js `node:test`、OpenAI Sites

**Spec:** `docs/superpowers/specs/2026-09-21-prefetched-next-bid-explanations-design.md`

**Execution note:** Sites 规则要求只有当前站点所有者编辑和发布，因此主代理使用 `superpowers:executing-plans` 执行；子代理仅做每个 chunk 的计划/代码审查，不编辑站点、不调用 Sites 工具。

---

## Chunk 1: 构建、迁移与解析边界

### Task 1: 建立可部署的 D1/R2 工程骨架

**Files:**
- Modify: `.openai/hosting.json`
- Modify: `.gitignore`
- Modify: `package.json`
- Create: `package-lock.json`
- Create: `drizzle.config.ts`
- Create: `db/schema.ts`
- Create: `worker/dataset/state.js`
- Modify: `worker/index.js`
- Create: `scripts/build.mjs`
- Modify: `scripts/validate-artifact.mjs`
- Create: `tests/artifact.test.mjs`
- Create: `tests/schema-contract.test.mjs`
- Create: `tests/helpers/test-bindings.mjs`
- Modify: `tests/explanation-api.test.mjs`

- [ ] **Step 1: 写失败的产物测试**

`tests/artifact.test.mjs` 在临时目录运行构建，断言：

```js
assert.equal(manifest.d1, "DB");
assert.equal(manifest.r2, "STAGING");
assert.equal(typeof bundled.default?.fetch, "function");
assert.equal((await glob("dist/.openai/drizzle/*_dataset.sql")).length, 1);
```

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test tests/artifact.test.mjs`

Expected: FAIL，因为 D1/R2 声明、迁移和新构建脚本不存在。

- [ ] **Step 3: 添加最小依赖和脚本**

保留 Node test runner，以 `--save-exact` 锁定执行时解析到的确切版本，并提交 lockfile：

```bash
npm install --save-exact fflate
npm install --save-dev --save-exact drizzle-kit drizzle-orm esbuild miniflare
```

然后把脚本设为：

```json
{
  "db:generate": "drizzle-kit generate --name dataset",
  "build": "node scripts/build.mjs dist",
  "validate": "node scripts/validate-artifact.mjs",
  "test": "node --test tests/*.test.mjs"
}
```

Expected: `package-lock.json` 生成，安装无 unresolved dependency。

- [ ] **Step 4: 写 schema 契约测试并确认 RED**

`drizzle.config.ts` 使用固定配置：

```ts
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
});
```

先创建 `tests/schema-contract.test.mjs`，尝试查找并应用唯一的 `drizzle/*_dataset.sql`，再以 `sqlite_schema` 与 PRAGMA 断言预期六表和索引。

Run: `node --test tests/schema-contract.test.mjs`

Expected: FAIL，因为迁移和表尚不存在。

- [ ] **Step 5: 定义 Drizzle schema**

`db/schema.ts` 定义：

```ts
export const biddingRules = sqliteTable("bidding_rules", {
  generationId: text("generation_id").notNull(),
  system: text("system").notNull(),
  sequence: text("sequence").notNull(),
  explanation: text("explanation").notNull(),
  hasExplanation: integer("has_explanation").notNull(),
  isAlert: integer("is_alert").notNull(),
  sourceOrder: integer("source_order").notNull(),
}, (t) => [primaryKey({ columns: [t.generationId, t.system, t.sequence] })]);
```

同文件精确定义：

```text
dataset_state:
  id INTEGER PRIMARY KEY; active_generation_id TEXT NULL;
  previous_generation_id TEXT NULL; last_success_at INTEGER NULL;
  retry_after INTEGER NULL; lease_owner TEXT NULL;
  lease_until INTEGER NULL; lease_token INTEGER NOT NULL DEFAULT 0;
  next_step_not_before INTEGER NOT NULL DEFAULT 0

dataset_generations:
  generation_id TEXT PRIMARY KEY; status TEXT NOT NULL CHECK status IN
  ('staging','active','previous','failed','cleanup'); source_fingerprint TEXT NULL;
  created_at/updated_at INTEGER NOT NULL; lease_token INTEGER NOT NULL;
  cleanup_system TEXT NULL; cleanup_sequence TEXT NULL

dataset_imports:
  generation_id/system composite PK; stage TEXT NOT NULL CHECK stage IN
  ('source','download_zip','extract_txt','import_chunks','validate_system','complete','failed');
  zip_key/txt_key TEXT NULL; byte_cursor/line_no/valid_count/duplicate_count/
  invalid_count/final_count INTEGER NOT NULL DEFAULT 0; pending_delete_keys TEXT NOT NULL DEFAULT '[]'

explanation_cache:
  cache_key TEXT PRIMARY KEY; explanation TEXT NOT NULL; is_alert INTEGER NOT NULL;
  expires_at/created_at INTEGER NOT NULL

rate_limit_buckets:
  bucket_key TEXT PRIMARY KEY; tokens REAL NOT NULL; updated_at INTEGER NOT NULL
```

外键 `dataset_imports.generation_id → dataset_generations.generation_id ON DELETE CASCADE`；CHECK 约束限制体系和布尔整数。索引必须包含：`bidding_rules(generation_id,system,sequence)`、`explanation_cache(expires_at)`、`rate_limit_buckets(updated_at)`、`dataset_generations(status,generation_id)`。

`tests/schema-contract.test.mjs` 把生成迁移应用到 Miniflare D1，使用 `sqlite_schema` 与 `PRAGMA table_info/foreign_key_list/index_list` 逐项断言六张表、字段、默认值、CHECK/外键和索引，而不只检查文件存在。

- [ ] **Step 6: 生成并检查迁移**

Run: `npm run db:generate`

Expected: 生成唯一的 `drizzle/*_dataset.sql` 及匹配的 `drizzle/meta/**`。

逐条检查 SQL：只含 schema 变更；无 seed、运行时建表、超大 values 或多语句 prepare；新增列默认值符合 D1 规则。

- [ ] **Step 7: 实现可移植 bundle 和最小运行时接线**

`.openai/hosting.json` 改为：

```json
{
  "project_id": "appgprj_6ab0d06b5d0c8191839de61b33ed87ab",
  "d1": "DB",
  "r2": "STAGING"
}
```

`scripts/build.mjs` 使用 esbuild 的 `platform: "browser"`、`format: "esm"`、`conditions: ["worker","browser"]` 将 `worker/index.js` bundle 为 `dist/server/index.js`，禁止 Node built-in polyfill。脚本复制清单到 `dist/.openai/hosting.json`，复制 `drizzle/**` 到 `dist/.openai/drizzle/**`，不输出 source map 或秘密。浏览器 raw-module 插件延后到 Task 2，因为本任务尚无 `worker/bidding.js`。

`worker/dataset/state.js` 提供 `ensureDatasetState(db)`，运行数据初始化而非 schema 初始化：

```sql
INSERT OR IGNORE INTO dataset_state
  (id, lease_token, next_step_not_before) VALUES (1, 0, 0)
```

Worker 每个需要状态的入口先调用该幂等函数，使空数据库能领取首次租约；严禁运行时 `CREATE/ALTER`。

本任务修改 `worker/index.js`：现有页面/API 路由处理前验证 `env.DB.prepare` 与 `env.STAGING.get` 存在并调用 `ensureDatasetState(env.DB)`；缺绑定返回 503。除此之外保持现有页面和 `/api/explain` 行为，不提前创建 `/api/dataset-status`。

`tests/helpers/test-bindings.mjs` 提供最小 D1/R2 测试替身；`tests/explanation-api.test.mjs` 的 `env` 必须合并该替身，否则现有 200/400/503 测试会在新绑定检查处提前得到 503。

- [ ] **Step 8: GREEN 并提交**

Run: `node --test tests/artifact.test.mjs`

Run: `node --test tests/schema-contract.test.mjs`

Run: `npm run build`

Run: `npm run validate`

`tests/artifact.test.mjs` 还必须把最终 `dist/server/index.js` 作为 modules Worker 加载进 Miniflare，绑定临时 D1 `DB` 和 R2 `STAGING`，应用迁移后请求现有 `/` 两次，断言均为 200、无 Node built-in/runtime/binding 错误且 `dataset_state(id=1)` 只存在一行。

Expected: 全部 PASS；产物导出并实际执行 `default.fetch(request, env, ctx)`。

```bash
git add .openai/hosting.json .gitignore package.json package-lock.json drizzle.config.ts db/schema.ts drizzle worker/dataset/state.js worker/index.js scripts/build.mjs scripts/validate-artifact.mjs tests/artifact.test.mjs tests/schema-contract.test.mjs
git commit -m "build: add dataset persistence bindings"
```

### Task 2: 提取共享叫牌规则和 TXT 解析器

**Files:**
- Create: `worker/bidding.js`
- Create: `worker/dataset/parser.js`
- Modify: `worker/index.js`
- Modify: `scripts/build.mjs`
- Modify: `tests/board-cycle.test.mjs`
- Create: `tests/dataset-parser.test.mjs`
- Create: `tests/client-module-artifact.test.mjs`

- [ ] **Step 1: 写共享叫牌规则失败测试**

从现有 Worker 行为提取并测试：

```js
assert.deepEqual(boardInfo(1), { dealer: "N", vul: "None" });
assert.ok(legalBids([]).includes("1C"));
assert.equal(finished(["P", "P", "P", "P"]), true);
assert.equal(normalizeSequence("1c_p_1n"), "1C_P_1N");
```

- [ ] **Step 2: 写 TXT 解析失败测试**

覆盖合法行、少字段、错误体系、非法序列、重复序列第一条优先、`Y` ALERT，以及 `"\t　"` 等 Unicode 空白解释。另对原始 `Uint8Array` 测试严格 UTF-8 解码、恰好 8192 字节通过、8193 字节失败；行上限始终按 UTF-8 字节数，不按 JS 字符数：

```js
assert.deepEqual(parseLine("1N#CBB#15–17点#Y#0#1#0", "CBB", 7), {
  sequence: "1N", system: "CBB", explanation: "15–17点",
  hasExplanation: 1, isAlert: 1, sourceOrder: 7
});
assert.equal(parseLine("1C#CBB#\t　##0#1#0", "CBB", 8).hasExplanation, 0);
```

- [ ] **Step 3: 运行并确认 RED**

Run: `node --test tests/board-cycle.test.mjs tests/dataset-parser.test.mjs`

Expected: FAIL，因为模块和导出尚不存在。

- [ ] **Step 4: 实现最小纯函数**

`worker/bidding.js` 成为服务端与浏览器状态的唯一合法叫品定义。本任务给 `scripts/build.mjs` 增加 `?raw` 插件，把同一文件原文嵌入 Worker，并让 `/assets/bidding.js` 直接提供该 ES module，保证浏览器不复制规则。`worker/dataset/parser.js` 先用 `new TextDecoder("utf-8", { fatal: true })` 解码原始字节，再以 `TextEncoder` 计算每行 UTF-8 字节数；空白行返回 `blank`，任何非法非空行返回稳定错误码；重复过滤器按首次出现保留记录。

在 `tests/client-module-artifact.test.mjs` 先写构建后失败断言：Worker 的 `/assets/bidding.js` 响应字节必须等于 `worker/bidding.js` 原文，且将响应作为 `data:text/javascript` module 导入后可调用 `legalBids`。

Run: `node --test tests/client-module-artifact.test.mjs`

Expected: FAIL，因为 raw 插件和静态资源路由尚未存在。

- [ ] **Step 5: GREEN 并提交**

Run: `node --test tests/board-cycle.test.mjs tests/dataset-parser.test.mjs`

Run: `node --test tests/client-module-artifact.test.mjs`

Expected: PASS，1–32 副局况循环不变；产物资源与源文件字节一致并可执行。

```bash
git add worker/bidding.js worker/dataset/parser.js worker/index.js scripts/build.mjs tests/board-cycle.test.mjs tests/dataset-parser.test.mjs
git commit -m "refactor: share bidding and dataset parsing rules"
```

### Task 3: 安全下载和解析 ZIP

**Files:**
- Create: `worker/dataset/download.js`
- Create: `worker/dataset/zip.js`
- Create: `tests/dataset-download.test.mjs`
- Create: `tests/dataset-zip.test.mjs`
- Create: `tests/fixtures/zip-fixtures.mjs`
- Create: `tests/fixtures/zip-worker-entry.mjs`
- Create: `tests/dataset-bundle-smoke.test.mjs`

- [ ] **Step 1: 写下载安全失败测试**

测试 `fetchBoundedZip(url, deps)`：只允许配置的 OSS 主机、http/https、无 userinfo、标准端口；`redirect: "manual"`；最多三跳且逐跳复验；流式实际字节超过 8 MiB 会 cancel；15 秒超时。

- [ ] **Step 2: 写 ZIP 限制失败测试**

用内存 fixture 覆盖：一个匹配 TXT；允许目录项；缺失/错误体系文件名；附加普通文件；`../`；绝对路径；加密条目；未知方法；超过 8 个条目；伪造或实际中央目录超过 64 KiB；文件名超过 256 字节；严格 UTF-8 失败；中央目录声称很小但实际解压输出超过 16 MiB；畸形 ZIP。

- [ ] **Step 3: 运行并确认 RED**

Run: `node --test tests/dataset-download.test.mjs tests/dataset-zip.test.mjs`

Expected: FAIL，因为下载器和 ZIP 解析器不存在。

- [ ] **Step 4: 实现下载器和单文件解压**

`download.js` 注入 `fetch/setTimeout` 便于测试，逐块累计字节；`zip.js` 先解析并限制中央目录，再用 fflate 的流式 `Unzip`/`AsyncUnzipInflate` 只解压匹配的 `<SYSTEM>.txt`，在每个输出 chunk 到达时累计实际字节，超过 16 MiB 立即终止，不先分配完整输出。每个错误返回稳定代码，日志不含完整 URL 查询串。

- [ ] **Step 5: GREEN 并提交**

Run: `node --test tests/dataset-download.test.mjs tests/dataset-zip.test.mjs`

Run: `node --test tests/dataset-bundle-smoke.test.mjs`

`tests/fixtures/zip-worker-entry.mjs` 是仅测试用的最小 Worker，导入 `worker/dataset/zip.js` 并在 `/zip-smoke` 调用它；`tests/dataset-bundle-smoke.test.mjs` 用 esbuild 以 `platform: "browser"`, `format: "esm"`, `bundle: true` bundle 该入口和 fflate 依赖，再在 Miniflare Worker module 中真实执行匹配 TXT fixture 的解压请求，覆盖流式输出上限；这样 ZIP 模块即使尚未被主入口引用，也不能带入 Node-only API 或 Worker 不兼容代码。

Expected: PASS。

Run: `npm test`

Run: `npm run build`

Run: `npm run validate`

Expected: 全套测试与最终 Worker 产物仍通过。

```bash
git add worker/dataset/download.js worker/dataset/zip.js tests/dataset-download.test.mjs tests/dataset-zip.test.mjs tests/fixtures/zip-fixtures.mjs tests/fixtures/zip-worker-entry.mjs tests/dataset-bundle-smoke.test.mjs
git commit -m "feat: validate bidding dataset archives"
```

## Chunk 2: 可续跑数据更新状态机

### Task 4: 实现来源清单、R2 生命周期和基线生成

**Files:**
- Create: `worker/upstream.js`
- Create: `worker/dataset/storage.js`
- Create: `scripts/generate-baseline.mjs`
- Create: `data/bidding-baseline.json`
- Create: `tests/upstream-source.test.mjs`
- Create: `tests/dataset-storage.test.mjs`

- [ ] **Step 1: 写来源接口失败测试**

验证 `/bs/bid/source` 请求精确包含服务器端 `sessionid/type/uid/version`，且只接受 HTTP 2xx、合法 JSON、`rcode=0000` 和四个 URL；响应和错误不泄露秘密。

- [ ] **Step 2: 写 R2 生命周期失败测试**

以内存 R2 替身覆盖：ZIP 成功转成 TXT 后删除 ZIP；体系完成后删除 TXT；删除失败进入待清理；重复删除成功；失败任务保留续跑所需对象；失败 generation 清理全部对象。

- [ ] **Step 3: 运行 RED**

Run: `node --test tests/upstream-source.test.mjs tests/dataset-storage.test.mjs`

Expected: FAIL，因为上游和暂存模块不存在。

- [ ] **Step 4: 实现来源与暂存模块**

`worker/upstream.js` 只读取 `XINRUI_SESSION_ID/XINRUI_UID/XINRUI_VERSION/XINRUI_BASE_URL`；`storage.js` 使用确定性的 `staging/<generation>/<system>.zip|txt` 键和幂等 put/get/delete。

- [ ] **Step 5: 生成发布基线**

`scripts/generate-baseline.mjs` 复用生产下载、ZIP 与 TXT 解析器，只输出：

```json
{
  "generatedAt": "<ISO timestamp>",
  "systems": {
    "CBB": { "uniqueRecords": 12345, "sha256": "..." }
  }
}
```

运行时通过安全环境变量提供已授权凭据，不把请求或秘密打印到控制台：

Run: `node scripts/generate-baseline.mjs`

Expected: 四个体系均有正数 `uniqueRecords` 和 64 位摘要；人工确认计数与压缩包规模合理后提交。

- [ ] **Step 6: GREEN 并提交**

Run: `node --test tests/upstream-source.test.mjs tests/dataset-storage.test.mjs`

```bash
git add worker/upstream.js worker/dataset/storage.js scripts/generate-baseline.mjs data/bidding-baseline.json tests/upstream-source.test.mjs tests/dataset-storage.test.mjs
git commit -m "feat: stage and baseline bidding datasets"
```

### Task 5: 实现 D1 仓储、租约和 fencing

**Files:**
- Create: `worker/dataset/repository.js`
- Create: `tests/helpers/miniflare.mjs`
- Create: `tests/dataset-repository.test.mjs`

- [ ] **Step 1: 建立真实 D1 测试夹具**

`tests/helpers/miniflare.mjs` 启动隔离 Miniflare D1/R2，逐文件执行生成的迁移；每个测试使用新实例，结束时 dispose。

- [ ] **Step 2: 写租约 RED 测试**

覆盖：`next_step_not_before` 前不能领取；每步随机 owner；token 单调增加；25 秒租约；提交后条件释放；并发只一方成功；过期旧 owner 恢复后对规则行、游标、状态和释放均零修改。

- [ ] **Step 3: 写幂等分片 RED 测试**

同一 `generation/system/byte_cursor` 重放两次，数据库仍只保留第一条序列；规则 INSERT 和 cursor 更新必须同一 batch。断言 JSON payload ≤128 KiB、≤500 条、≤6 bind、batch ≤5 statements、单次调用 ≤10 D1 queries。

- [ ] **Step 4: 运行并确认 RED**

Run: `node --test tests/dataset-repository.test.mjs`

Expected: FAIL，因为仓储尚未实现。

- [ ] **Step 5: 实现条件 SQL**

关键写入形态：

```sql
INSERT OR IGNORE INTO bidding_rules (...)
SELECT ?, json_extract(value,'$.system'), ...
FROM json_each(?)
WHERE EXISTS (
  SELECT 1 FROM dataset_state
  WHERE id=1 AND lease_owner=? AND lease_token=? AND lease_until>?
)
```

同一 batch 的最后一条条件更新推进 cursor、设置 `next_step_not_before` 并释放租约；若 `meta.changes !== 1`，调用者把整步当作 stale，不进行任何后续状态写入。

- [ ] **Step 6: GREEN 并提交**

Run: `node --test tests/dataset-repository.test.mjs`

Expected: PASS。

```bash
git add worker/dataset/repository.js tests/helpers/miniflare.mjs tests/dataset-repository.test.mjs
git commit -m "feat: add fenced dataset repository"
```

### Task 6: 编排跨请求更新状态机

**Files:**
- Create: `worker/dataset/refresh.js`
- Create: `tests/dataset-refresh.test.mjs`

- [ ] **Step 1: 写状态转换 RED 测试**

状态顺序必须为：

```text
idle/stale → source → download_zip → extract_txt → import_chunks
→ validate_system → (next system) → validate_generation → activate → cleanup
```

每次 `advanceRefresh()` 只执行一个节点；测试六小时边界、15 分钟失败重试、旧 active 立即可用、四体系全部完成才激活、active/previous 两代保留。

- [ ] **Step 2: 写崩溃与恢复 RED 测试**

在来源、下载、解压、每个 import chunk、体系完成、激活和 cleanup 后注入崩溃。重启后从持久游标继续；重复步骤幂等；失败 generation 每次最多删 1,000 行；旧 worker 不能激活或标记失败。

- [ ] **Step 3: 写计数与 R2 RED 测试**

首次计数必须在 `data/bidding-baseline.json` 的 80%–200%；后续同时满足 baseline 与 previous active。非法非空行使整代失败。激活时不存在必需暂存对象；删除失败对象进入后续 cleanup。

- [ ] **Step 4: 运行 RED**

Run: `node --test tests/dataset-refresh.test.mjs`

Expected: FAIL，因为状态机尚未实现。

- [ ] **Step 5: 实现一个步骤的编排**

`advanceRefresh({ env, now, fetch })`：先领取一步租约；读取 generation/import 状态；执行一个有界动作；用当前 fence 提交或失败；绝不循环完成下一步。错误日志只含 `stage/system/errorCode/count`。

基线清单作为只读 JSON 由 esbuild 嵌入 Worker；状态机在首次体系校验和后续 active 对比中只读取该对象，不从浏览器或 R2 接受阈值。

- [ ] **Step 6: GREEN 并提交**

Run: `node --test tests/dataset-refresh.test.mjs`

Expected: PASS。

```bash
git add worker/dataset/refresh.js tests/dataset-refresh.test.mjs
git commit -m "feat: add resumable dataset refresh workflow"
```

## Chunk 3: 查询 API 与页面交互

### Task 7: 实现数据库优先的解释查询和共享限流

**Files:**
- Create: `worker/explanations.js`
- Create: `worker/rate-limit.js`
- Modify: `worker/index.js`
- Modify: `tests/explanation-api.test.mjs`
- Create: `tests/explanations-batch.test.mjs`
- Create: `tests/rate-limit.test.mjs`

- [ ] **Step 1: 写批量输入与同源 RED 测试**

覆盖 content type、16 KiB、Origin、Sec-Fetch-Site、未知字段、1–40 序列、规范化重复、1,024 字符、1–320 叫品、体系/发牌人/局况/赛制枚举，并断言无效批次不访问 D1 之外的上游。

- [ ] **Step 2: 写查询链 RED 测试**

断言一次 D1 查询按 active generation 找到 `has_explanation=1`；空解释继续缓存；缓存键包含 `system/dealer/vul/teammode/sequence/version/lang=1`；剩余 miss 最多四并发访问 `/bidcomment`，保持输入顺序。

- [ ] **Step 3: 写共享限流 RED 测试**

批量和单项接口都必须先通过同一来源/全站原子桶才可上游兜底；数据库/缓存命中不扣额度；缺 DB/HMAC 或事务失败时只把 miss 标为 unavailable，不影响数据库结果；单项接口不能绕过。

- [ ] **Step 4: 运行 RED**

Run: `node --test tests/explanation-api.test.mjs tests/explanations-batch.test.mjs tests/rate-limit.test.mjs`

Expected: FAIL。

- [ ] **Step 5: 实现 API 契约**

`POST /api/explanations` 返回有序 results；`POST /api/explain` 保持旧请求结构和 200/404/503 映射；无 active 数据时都返回精确 initializing 503 和 `Retry-After: 3`。上游非 2xx、超时、畸形/超大 JSON、非 `0000` 为 unavailable；`0000` 空解释为 missing。

- [ ] **Step 6: GREEN 并提交**

Run: `node --test tests/explanation-api.test.mjs tests/explanations-batch.test.mjs tests/rate-limit.test.mjs`

Expected: PASS。

```bash
git add worker/explanations.js worker/rate-limit.js worker/index.js tests/explanation-api.test.mjs tests/explanations-batch.test.mjs tests/rate-limit.test.mjs
git commit -m "feat: query imported bidding explanations"
```

### Task 8: 暴露安全状态端点并推进后台步骤

**Files:**
- Modify: `worker/index.js`
- Create: `tests/dataset-status-api.test.mjs`

- [ ] **Step 1: 写精确契约 RED 测试**

分别断言 `idle/refreshing/initializing/retry_wait` 的 HTTP 200、`dataAvailable`、`nextPollSeconds` 和 `lastUpdatedAt`。快速重复调用在 `next_step_not_before` 前不能启动新步骤；根页面和解释请求也最多调度一步。

- [ ] **Step 2: 运行 RED**

Run: `node --test tests/dataset-status-api.test.mjs`

Expected: FAIL。

- [ ] **Step 3: 接入 `ctx.waitUntil`**

路由只在仓储成功 claim 后调用：

```js
ctx.waitUntil(advanceClaimedStep({ env, claim }));
```

响应不等待更新，不暴露 URL、游标、generation 或内部错误。没有 `ctx.waitUntil` 的测试环境使用注入的 collector，不让 promise 丢失。

- [ ] **Step 4: GREEN 并提交**

Run: `node --test tests/dataset-status-api.test.mjs`

```bash
git add worker/index.js tests/dataset-status-api.test.mjs
git commit -m "feat: expose dataset refresh status"
```

### Task 9: 实现真实建议预取、点击推进和品牌细节

**Files:**
- Create: `worker/client-state.js`
- Create: `worker/page.js`
- Modify: `worker/index.js`
- Modify: `scripts/build.mjs`
- Create: `tests/client-state.test.mjs`
- Create: `tests/page-behavior.test.mjs`

- [ ] **Step 1: 写客户端状态 RED 测试**

`suggestionContext` 必须包含 bids/system/dealer/vul/teammode/board；`commitSuggestedBid` 重新计算合法叫品；旧建议、非法叫品和双击均不改变状态；终局不产生空批次。

- [ ] **Step 2: 写页面行为 RED 测试**

在 Node `vm` + 最小 DOM 中验证：加载态；一个批量请求；found/missing/unavailable/initializing；3/5/8/13/21/30 秒退避；上下文变化取消旧请求；迟到响应不写回；静默 dataset-status 轮询；建议点击真实加入历史并只发生一次。

断言 ALERT DOM 精确为：

```html
<strong class="alert-badge" aria-label="ALERT">🅰︎</strong>
```

且不存在链接。HTML 精确包含：

```html
<footer>北京析构整环桥牌俱乐部出品</footer>
```

- [ ] **Step 3: 运行 RED**

Run: `node --test tests/client-state.test.mjs tests/page-behavior.test.mjs`

Expected: FAIL，因为当前建议仍为概述且点击只预览。

- [ ] **Step 4: 实现共享状态和页面**

`worker/client-state.js` 导出纯状态函数；`worker/page.js` 生成 HTML 与 module script。构建脚本以同一 `?raw` 方式提供 `client-state.js`，页面只导入该模块，不复制合法性规则。页面只用 `textContent` 放上游解释，固定创建 ALERT 元素；第一次建议点击同步清除旧列表和取消旧 controller，再推进状态并预取下一轮。

- [ ] **Step 5: GREEN 并提交**

Run: `node --test tests/client-state.test.mjs tests/page-behavior.test.mjs tests/board-cycle.test.mjs`

Expected: PASS。

```bash
git add worker/client-state.js worker/page.js worker/index.js tests/client-state.test.mjs tests/page-behavior.test.mjs
git commit -m "feat: prefetch and commit real bidding suggestions"
```

## Chunk 4: 全量验证与公开发布

### Task 10: 本地集成验证和安全检查

**Files:**
- Verify: all source, migrations, tests, and generated artifacts

- [ ] **Step 1: 运行全部测试**

Run: `npm test`

Expected: 全部 PASS，无未处理 promise 或资源泄漏。

- [ ] **Step 2: 构建和验证产物**

Run: `npm run build`

Run: `npm run validate`

Expected: Worker bundle、D1 migration 和 hosting manifest 完整。

- [ ] **Step 3: 用 Miniflare 做完整导入**

使用四个已下载测试包或生产基线包反复请求状态端点，直到 active generation 完成。断言四体系计数在基线范围、R2 无暂存 ZIP/TXT、第二次解释查询 `source=database`。

- [ ] **Step 4: 检查秘密与 diff**

Run: `rg -n "370397_|XINRUI_SESSION_ID|XINRUI_UID|RATE_LIMIT_HMAC_KEY" worker dist data drizzle`

Expected: 不出现真实凭据；只允许环境变量名。

Run: `git diff --check`

Expected: 无输出。

- [ ] **Step 5: 提交必要的集成修正**

如发现问题，先补失败测试再修复；无改动则不创建空提交。

```bash
git add -A
git commit -m "test: verify visitor-driven dataset refresh"
```

### Task 11: 配置托管环境并部署既有公开站点

**Files:**
- Deploy: exact pushed commit and matching archive

- [ ] **Step 1: 重新读取 Sites 状态**

复用现有 project id，确认当前 audience 仍为 public；不创建新 Site，不改变公开范围。

- [ ] **Step 2: 配置环境秘密**

保留现有 `XINRUI_*`，生成至少 32 字节随机 `RATE_LIMIT_HMAC_KEY` 并作为 secret 保存。不得写入源码、命令输出或归档。

- [ ] **Step 3: 推送精确源码**

获取短期源码凭据，推送当前分支。运行：

Run: `git rev-parse --verify HEAD`

Expected: 复制完整 40 位 SHA，并确认远端分支 HEAD 是同一 SHA。

- [ ] **Step 4: 打包、保存和部署**

归档必须来自同一提交，包含 `dist/server/index.js`、`dist/.openai/hosting.json` 和完整 `dist/.openai/drizzle/**`。用 Sites 原生工具保存一个版本，再部署到现有公开 URL；pending 时只轮询同一 deployment id 到终态。

- [ ] **Step 5: 线上初始化和限额验证**

打开现有站点一次以触发初始化；让页面状态轮询推进分段任务。确认在真实 Worker/D1/R2 限额内完成四体系导入、active generation 有效、R2 无暂存对象、无迁移错误。

- [ ] **Step 6: 线上功能回归**

验证：

- `CBB / N / None / 1N` 第二次查询返回 `found` 且 `source=database`。
- 建议显示真实说明；点击后进入历史并加载下一轮；双击不重复。
- ALERT 为加粗 `🅰︎` 且不是链接。
- 页底显示“北京析构整环桥牌俱乐部出品”。
- 第 1–16 副局况符合标准循环。
- 模拟过期时间后，第一位访客触发后台 refresh，而旧数据继续立即返回。

- [ ] **Step 7: 完成浏览器交付**

部署状态必须为 `succeeded` 且返回生产 URL。复用现有 Sites 标签页打开该 URL；若浏览器交付失败但部署成功，仍返回已验证的生产 URL。
