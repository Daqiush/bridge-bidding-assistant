# TXT 数据库优先的叫品解释与六小时更新设计

## 目标

网页复用原 Android App 的四套叫牌体系数据：从新睿来源接口取得 ZIP，解析其中的 `JQA.txt`、`CBB.txt`、`NBS.txt` 与 `ASY.txt`，导入网站的 D1 数据库。R2 只暂存可续跑导入所需的 ZIP/TXT，完成后删除，不承担线上查询。下一步建议优先批量查询 D1；数据库没有对应序列时才调用原叫品解释接口。

点击下一步建议必须真实推进叫牌。ALERT 显示为加粗 `🅰︎`，页面底部显示“北京析构整环桥牌俱乐部出品”。网站和自动更新均运行在托管端，不依赖用户电脑在线。

## 用户交互

- 页面初次载入，以及叫牌、撤销、清空、切换体系、切换赛制或切换牌副后，重新计算合法下一叫。
- 下一步建议保持现有顺序：特殊叫品 `P/X/XX` 优先，其余叫品按级别和花色排列。
- 批量查询期间每项显示“正在查询…”，但合法建议仍可点击。
- 查询成功后显示 TXT 或接口返回的真实解释。需要 ALERT 时，在解释后显示加粗的 `🅰︎`；它带有 `aria-label="ALERT"`，不显示 `· ALERT`，也不链接到外部网站。
- 数据库与接口均没有解释时显示“暂无说明”；暂时无法查询时显示“说明暂时不可用”。单项失败不影响其他建议。
- 点击建议后先按当前叫牌状态重新验证合法性。第一次合法点击同步禁用并清除旧建议、追加该叫品、更新当前座位和终局状态，然后加载新一轮建议。连续点击或过期元素不得重复追加。
- 历史叫品仍可点击查询完整前缀对应的真实解释。
- 页面底部以低调、可读的样式显示“北京析构整环桥牌俱乐部出品”。
- 后台更新有旧数据可用时不显示常驻提示。首次部署尚无可用数据时显示“正在初始化叫牌库”，并自动重试查询；初始化不阻止用户操作叫牌面板。

## 数据模型

D1 使用迁移管理以下逻辑表，不在运行时建表：

### `bidding_rules`

- `generation_id`: 数据版本标识
- `system`: `JQA | CBB | NBS | ASY`
- `sequence`: 大写、下划线分隔的叫牌序列
- `explanation`: 使用 JavaScript Unicode `trim()` 规范化后的中文解释
- `has_explanation`: 规范化解释是否非空，`0 | 1`
- `is_alert`: `0 | 1`
- `source_order`: 原 TXT 行号
- 主键：`generation_id + system + sequence`
- 查询索引：`generation_id + system + sequence`

原 App 使用 `find` 返回 TXT 中同一序列的第一条记录。导入时按 `source_order` 处理，并以第一条合法记录为准，后续重复记录忽略，以保持一致行为。

### `dataset_state`

固定一行保存：

- `active_generation_id`: 当前启用版本
- `previous_generation_id`: 上一个可回退版本
- `last_success_at`: 最近一次四体系全部成功并切换的时间
- `retry_after`: 最近失败后的最早重试时间
- `lease_owner`、`lease_until` 与单调递增的 `lease_token`: 更新互斥租约与 fencing token

### `dataset_generations` 与 `dataset_imports`

`dataset_generations` 保存每个临时或已启用版本的 `status`、创建/更新时间、租约 token、来源指纹、总进度和清理游标。`dataset_imports` 为每个 `generation_id + system` 保存阶段（等待下载、已暂存、导入中、已完成、失败）、R2 暂存键、TXT 字节游标、原始行号、有效/重复/非法行计数和最终记录数。

`dataset_state` 另存 `next_step_not_before`，用于服务端节流。每个导入步骤都以 `generation_id + system + byte_cursor` 标识并可重复执行。规则写入与游标推进放在同一个 D1 `batch()` 中；若调用中断，事务整体回滚，重试不会跳行。主键和 `INSERT OR IGNORE` 使重复执行保持第一条记录优先。

### `explanation_cache`

保存数据库未命中后由 `/bidcomment` 得到的成功解释，键包含体系、发牌人、局况、赛制、完整叫牌序列、后端配置的应用版本与固定语言代码 `1`，过期时间为六小时。`missing` 和 `unavailable` 不进入缓存；应用版本变化会自然使用新的键空间。

### `rate_limit_buckets`

保存公开批量接口的来源令牌桶与全站令牌桶。来源地址使用后端秘密 `RATE_LIMIT_HMAC_KEY` 做 HMAC-SHA-256 后保存，不保存裸 IP 或可枚举的普通哈希。

## 六小时访客触发更新

### 触发规则

- 根页面和解释接口请求都会检查 `dataset_state`。
- 当 `last_success_at` 距当前不足六小时，不触发更新。
- 超过六小时后的第一位访客通过一条带条件的 D1 更新获取租约；其他同时到达的访客继续使用旧版，不重复下载。
- 单次 Worker 调用只执行一个有界步骤，例如取得来源清单、下载并暂存一个 ZIP、解压一个 TXT、导入一个文本分片、完成一个体系、切换版本或清理一批旧数据。响应使用 `ctx.waitUntil()` 完成该有界步骤，不尝试在单次调用内完成四套全量导入。
- 页面在检测到更新任务进行中时静默轮询 `/api/dataset-status`；每次轮询只唤醒下一个有界步骤。首次初始化时同一轮询会显示“正在初始化叫牌库”。访客关闭页面不会破坏进度，下一位访客从 D1 游标继续。每次根页面或解释请求也会尝试推进一个步骤。
- 六小时从上次成功切换时间计算。失败后设置 `retry_after = now + 15 分钟`，在此之前不重复尝试；十五分钟后的第一位访客可再次获取租约。
- 每个有界步骤独立领取并释放租约，不把 owner 跨请求复用。领取使用单条条件更新：仅当 `next_step_not_before <= now` 且租约为空或已过期时，写入随机 owner、原子增加 `lease_token`、设置不超过 25 秒的 `lease_until`，并返回本次 owner/token。未领到的请求只返回状态，不执行工作。
- 步骤执行完后，在一个 D1 `batch()` 中提交结果、推进游标、设置 `next_step_not_before = now + 1 秒`，并条件释放租约。所有语句都通过 `INSERT ... SELECT ... WHERE EXISTS(...)` 或条件 `UPDATE` 同时校验 owner、token 和 `lease_until > now`。规则行本身也必须受此 fencing 条件约束，不能先无条件插入再检查游标。最后一条状态更新必须恰好影响一行，否则整步视为陈旧结果并丢弃。
- 新请求为下一步领取新的 owner/token。过期后恢复的旧 Worker 因 token 或有效期不匹配，对规则表、游标、完成状态、激活、失败标记和释放均产生零行修改。新任务继续同一未完成 generation；只有进度元数据不一致或已标记失败时才建立新 generation，并把旧 generation 放入待清理状态。

### 来源获取

更新任务向 `/bs/bid/source` 发送原 App 相同结构的服务器端请求：

```json
{
  "sessionid": "<server secret>",
  "type": 1,
  "uid": 0,
  "version": "1.0.0"
}
```

实际 `uid`、`sessionid` 和版本来自 Sites 后端环境变量。来源响应必须为 HTTP 2xx、合法 JSON 且 `rcode === "0000"`，并且同时包含四个体系 URL。所有凭据只存在服务端。

下载 URL 只接受 `http:` 或 `https:`，不得包含用户名、密码或非标准端口，主机必须精确匹配允许列表中的新睿 OSS 主机。请求使用 `redirect: "manual"`，最多跟随三跳；每一跳都重新验证协议、主机、端口和用户信息，任何越界立即失败。每个 ZIP 单独、顺序下载和解析，避免四份文件同时占用内存。

### ZIP 与 TXT 校验

- 每个 ZIP 下载超时 15 秒。不能只信任 `Content-Length`：通过流式读取累计实际字节，超过 8 MiB 立即取消响应并失败。
- ZIP 只接受一个与当前体系匹配的 TXT 文件；拒绝绝对路径、`..` 路径、加密条目、未知压缩方法和额外文件。
- ZIP 总条目数最多 8（允许必要目录项），中央目录元数据总长最多 64 KiB，单个文件名最多 256 字节；解析中央目录时先执行这些限制，再读取或解压条目。
- 解压后的 TXT 上限 16 MiB，按 UTF-8 严格解码。
- 每行格式为 `叫牌序列#体系#解释#ALERT#...`。空白行忽略；任何非空行若少于三列、体系错误、序列非法或超过 8 KiB，会使当前体系和整次更新失败。空解释是合法行，但查询时视为数据库未命中并走接口兜底。
- 每体系最多接受 250,000 条有效记录。实现阶段先从当前四个官方 ZIP 生成并提交只含体系、唯一有效记录数和文件摘要的基线清单；首次导入的唯一有效记录数必须处于对应基线的 80%–200% 之间，后续版本必须同时处于基线与上一 active 同体系计数的 80%–200% 之间。空文件、零条有效记录、异常截断、任何非法非空行或超过限制都会使整次更新失败。重复序列不算非法，但计入重复计数并保持第一条。
- ALERT 仅在第四列去除空白后精确等于 `Y` 时为真。
- ZIP 成功解压并把 TXT 完整写入 R2 后立即幂等删除对应 ZIP 对象；一个体系全部导入并校验完成后立即幂等删除其 TXT 对象。删除失败时把对象键加入 generation 的待清理列表，由后续有界步骤重试。任务失败时保留仍用于安全续跑的对象；generation 被标记失败后再由分批清理删除。版本激活前校验不存在仍必需的暂存对象，激活完成后 active/previous generation 不依赖也不长期保留 ZIP/TXT。

### 原子切换与清理

1. 为本次更新生成新的 `generation_id` 和四条体系进度记录。
2. 每次调用最多处理一个 512 KiB TXT 分片或 500 条记录，并保存精确字节游标。导入使用固定 SQL 配合 SQLite `json_each(?)`，把最多 500 条、序列化后不超过 128 KiB 的记录作为一个 JSON 绑定参数传入；单条语句最多 6 个绑定参数，每个 D1 `batch()` 最多 5 条语句，每次 Worker 调用的 D1 查询预算最多 10 条。顺序下载并导入四套体系；任何体系失败都不修改当前启用版本。
3. 四套体系均完成后，校验每套记录数大于零，并确认临时版本只包含预期四个体系。
4. 通过 D1 批处理原子地把原 `active_generation_id` 移到 `previous_generation_id`，把临时版本设为新的 active，并更新 `last_success_at`、清除失败重试与租约。整个批处理带 fencing 条件；受影响行数不符合预期即视为旧执行者并停止，绝不激活。
5. 保留 active 和 previous 两代。成功切换后把更旧 generation 放入清理状态；每次调用按主键游标最多删除 1,000 行，并删除对应 R2 暂存对象。清理失败不影响当前查询，并由后续请求继续。

任何下载、解析、数据库或校验失败都会在 fencing 条件仍成立时把临时版本标为失败、释放租约、设置十五分钟重试时间，并继续提供旧 active 版本。失败 generation 通过相同的分批清理流程删除，不执行无界 `DELETE`。绝不逐体系切换，从而避免混合新旧数据。

## 查询接口

浏览器调用同源 `POST /api/explanations`：

```json
{
  "system": "CBB",
  "dealer": "N",
  "vul": "None",
  "teammode": 0,
  "sequences": ["P", "1C", "1D"]
}
```

约束：

- `Content-Type` 必须为 `application/json`，正文不超过 16 KiB。
- 拒绝跨源 `Origin` 或 `Sec-Fetch-Site: cross-site`。
- `system` 只允许 `JQA/CBB/NBS/ASY`；`dealer` 只允许 `N/E/S/W`；`vul` 只允许 `None/NS/EW/All`；`teammode` 只允许整数 `0/1`。
- `sequences` 包含 1–40 个规范化后互不重复的字符串；每个序列总长不超过 1,024 字符，由 1–320 个合法叫品组成。
- 未知字段、重复序列或任何非法值使整批返回 HTTP 400，且不查询数据库之外的上游。

查询顺序：

1. 用 active generation、体系和序列一次批量查询 `bidding_rules`；SQL 明确要求 `has_explanation = 1`。导入时使用 JavaScript Unicode `trim()` 统一处理普通空格、制表符、换行、全角空格与其他 ECMAScript 空白字符并设置该标志；空白解释记录视为 miss，继续后续缓存和接口链路，不返回 `found`。
2. 数据库未命中的项查询六小时 `explanation_cache`。
3. 仍未命中的项才以最多四个并发调用 `/bidcomment`；单次八秒超时、响应正文上限 16 KiB，整批最多二十秒。
4. 只把 `found` 的接口结果写入缓存。
5. 按浏览器输入顺序返回结果。

响应示例：

```json
{
  "results": [
    {
      "sequence": "1N",
      "status": "found",
      "explanation": "15–17点，均衡牌型",
      "isAlert": false,
      "source": "database"
    }
  ]
}
```

每项包含 `sequence` 和 `status: found | missing | unavailable`。`found` 另含 `explanation`、`isAlert` 和 `source: database | cache | upstream`；其余状态不带这三个字段。

若尚无 active generation，合法批量请求返回 HTTP 503、响应头 `Retry-After: 3`，正文固定为：

```json
{
  "status": "initializing",
  "message": "正在初始化叫牌库，请稍后重试。",
  "retryAfter": 3
}
```

客户端保持合法叫品列表，按 3、5、8、13、21、30 秒并以 30 秒封顶的退避间隔自动重试；上下文变化会取消原重试。`GET /api/dataset-status` 固定返回 HTTP 200 和以下 JSON，不返回下载地址、内部游标或错误细节：

```json
{
  "status": "refreshing",
  "dataAvailable": true,
  "nextPollSeconds": 3,
  "lastUpdatedAt": "2026-09-21T12:00:00.000Z"
}
```

`status` 只允许 `idle | refreshing | initializing | retry_wait`。`idle` 的 `nextPollSeconds` 为 `null`；`refreshing/initializing` 为 3；`retry_wait` 为距离 `retry_after` 的向上取整秒数并限制在 1–900。无 active 数据时 `dataAvailable=false`、`lastUpdatedAt=null`。有 active 数据时为 true并返回最近成功时间。端点无论被多快调用，都只有满足服务端 `next_step_not_before` 且成功领取租约的请求可以推进一步，因此客户端不能通过忽略轮询建议制造并发下载或写入。

现有单项 `POST /api/explain` 保持兼容。请求仍为 `{ sequence, system, dealer, vul, teammode }`，使用同一“数据库 → 缓存 → 接口”查询链。返回规则保持：`found` 为 HTTP 200 并带 `explanation/isAlert/source`；`missing` 为 HTTP 404 并带用户可读 message；`unavailable` 为 HTTP 503；初始化时使用与批量接口相同的 HTTP 503 正文和 `Retry-After`。历史第 n 个叫品传递从开叫到该叫品为止的完整前缀。

## 限流与过期结果

- `POST /api/explanations` 与兼容的 `POST /api/explain` 共享同一组 D1 原子令牌桶；只要请求需要调用接口兜底，就必须先消耗额度。每来源地址每分钟 8 次兜底请求、突发 4 次；全站每分钟 30 次、突发 10 次。批量请求的一整批未命中项消耗一次额度，单项请求消耗一次；纯数据库或缓存命中不消耗上游额度。
- 超限返回 429 和 `Retry-After`，不访问接口。D1、HMAC 密钥或限流事务不可用时，兜底请求失败关闭为 `unavailable`，不绕过限流；数据库已命中的结果仍正常返回。
- 来源桶记录 24 小时未更新后由请求顺带有界清理；全站桶长期保留。
- 浏览器为每轮查询分配递增编号并用 `AbortController` 取消上一轮。取消只用于客户端保鲜，不假设它能取消已发出的 Worker 任务。
- 查询身份包含叫牌序列、体系、发牌人、局况、赛制和牌副编号。只有完整身份匹配且编号最新的结果可以写入列表。
- 终局取消当前预取、显示“叫牌已结束”，且不提交空批次。

## 错误归一化

- 整批格式、正文大小、内容类型和同源错误分别返回 HTTP 400/413/415/403。
- 数据库中 `has_explanation=1` 的合法记录为 `found`；Unicode 规范化后为空的解释视为 miss 并继续缓存和接口查询。
- `/bidcomment` 的 HTTP 非 2xx、超时、网络错误、JSON 非法、响应过大或 `rcode` 非 `0000` 为 `unavailable`。
- 只有 `rcode === "0000"` 且解释为空白时为 `missing`；缺失 `isalert` 按 `false`。
- 单项失败不使整批失败；批量响应仍为 HTTP 200，并保持输入顺序。
- 数据库临时故障时允许走受限的接口兜底；数据库和接口均不可用时不阻止叫牌操作。
- 服务器日志只记录阶段、体系、计数和稳定错误代码，不记录凭据、完整来源响应或用户地址。

## 验证

- TXT 解析测试覆盖合法行、少字段、空解释、制表符/全角空格/Unicode 空白解释、错误体系、非法序列、UTF-8、超长行、重复序列第一条优先和 ALERT。
- ZIP 测试覆盖四个预期文件、额外文件、路径穿越、压缩/解压大小上限、流式超限取消、条目数/中央目录/文件名上限、错误压缩方法、错误文件名、畸形压缩包、逐跳重定向验证和跳转次数上限。
- 更新测试覆盖六小时边界、第一访客触发、旧数据无等待、并发租约、租约过期后旧 Worker 恢复、单调 fencing token、十五分钟重试、四体系完整性、首次/后续计数阈值、原子切换、失败回退、保留两代和有界清理。
- 可续跑测试在来源、下载、解压、每个分片写入、体系完成和激活检查点分别模拟崩溃；确认每步领取新 token 后条件释放、跨调用继续、重复步骤幂等、游标不跳行、失败 generation 分批删除，以及过期执行者连规则行也不能写入或改变新状态。
- D1 限额测试断言导入步骤的 JSON 负载、绑定参数数、batch 语句数和每次调用查询数均不超过上述硬预算。
- 查询测试覆盖数据库优先、缓存次之、接口兜底、缓存键的应用版本和语言维度、最多四并发、部分失败、40 项边界、顺序保持、密钥不泄露、纯数据库命中不消耗上游限流，以及单项接口不能绕过共享来源/全站额度和失败关闭策略。
- API 测试覆盖初始化 503 的精确响应头、JSON 正文与客户端退避，`/api/dataset-status` 四种状态的精确契约、服务端 `next_step_not_before` 节流，以及 `/api/explain` 的兼容请求和全部状态映射。
- 页面测试覆盖真实说明、加载/缺失/不可用/初始化状态、静默刷新轮询、建议点击推进、连续点击只追加一次、加粗非链接 `🅰︎`、准确署名和所有上下文变化的迟到响应隔离。
- 保留标准 16 副局况循环测试。
- R2 生命周期测试覆盖 ZIP→TXT 后删除 ZIP、体系完成后删除 TXT、删除失败重试、任务失败续跑和失败 generation 幂等清理；确认 active/previous 不依赖暂存对象。
- 发布后在真实 Cloudflare Worker/D1/R2 限额内完成当前四套数据的分段导入，确认四个体系都有 active 记录且无遗留暂存 ZIP/TXT，第二次查询命中数据库；实际点击一个建议确认它进入历史并触发下一轮加载。
