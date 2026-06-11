## 修改需求

### 需求:POST /ingest 异步采集端点

`apps/api` **必须**提供 `POST /ingest`,用于「只管快速上报、不需要实时解析结果」的众包采集(如 Surge 插件)。它**同步**落 `product_raw` 后**立即**返回,把 tier2 解析与单价计算移出请求路径(见「后台异步解析」需求)。`/contribute`(同步返回完整解析结果)**保持不变**,两端点**并存**、服务两类客户端。

请求体**必须**复用 `/contribute` 既有的 `ContributeRequestSchema`(同一份 Zod SOT,**不**新增重复 schema):领域 `title`/`price`(`finite`,负价/0 价合法)/`categoryHint?`,溯源 `store`/`storeSku`(均 `trim().min(1)`)/`source?`/`sourceUrl?`/`capturedAt?`(int epoch ms)。`/ingest` 为**单条**上报;**批量**上报由 `POST /ingest/batch` 提供(见「POST /ingest/batch 批量异步采集端点」需求),两者并存、复用同一单条 schema 与同一落地/后台解析 helper。

编排顺序**必须**为:校验请求体 → 取 repository → `upsertRaw` 落 `product_raw` → **立即** `202` 返回 → 排程后台解析。`upsertRaw` 成功**即**返回 `202`,体为 `{ rawId }`(app 生成 TEXT id),过最小 `IngestResponseSchema`(`z.object({ rawId: z.string().min(1) })`)校验,失败 → `500 internal`。该端点**禁止**在 API 层重写任何解析或计算(tier 边界同 `/contribute`)。受 `api-governance` 治理(已纳入受保护端点集合)。

`/ingest` 请求路径的错误码集合**必须**为 `{ invalid-request(400), persistence-error(500), internal(500), accepted(202) }` 加治理码,**不含** `insufficient-information`/`config-error`——因为 `upsertRaw` 成功即 `202`,其后的 `orchestrate`/`saveParsed` 失败发生在**后台**、**不影响** HTTP 状态。raw 落地判据:`202` 体含 `rawId`(raw 已落);raw 未落的错误(`invalid-request`、DB 不可用/`upsertRaw` 抛错的 `persistence-error`)**不含** `rawId`;`internal`(响应自身校验失败的防御性兜底,`rawId` 恒非空故实质不可达)沿用 `/contribute` 既有「不附 rawId」例外。

#### 场景:合法上报秒返 202
- **当** 客户端携带合法 key,POST 一条带 `title`/`price`/`store`/`storeSku` 的有效商品到 `/ingest`
- **那么** 服务**必须** `upsertRaw` 落 `product_raw`、**立即**返回 `202` 与体 `{ rawId }`,**不**在响应里返回 `spec`/`unitPrice`/`confidence`/`warnings`(解析尚未完成)

#### 场景:缺去重键/请求体非法拒绝
- **当** 请求缺 `store`/`storeSku`(空串/纯空白/缺失)、或 `title` 空、或 `price` 非有限数
- **那么** 服务**必须**返回 `400 invalid-request`,**禁止**写任何行、**禁止**排程后台解析

#### 场景:DB 不可用报 persistence-error
- **当** 运行环境未注入 D1 binding,或 `makeRepo` 工厂/`upsertRaw` 抛错
- **那么** 服务**必须**返回 `500 persistence-error`(raw 未落,**不含** `rawId`),**禁止**排程后台解析

#### 场景:错误码不含 503
- **当** 检查 `/ingest` 请求路径可能返回的状态码
- **那么** **不存在** `503 insufficient-information` 或业务 `500 config-error`(这些是后台解析结果,不进 HTTP 响应)

### 需求:本能力不含读出与对比

本变更**仅做写入路径**。`/contribute` **禁止**附带实现 `/rankings`(榜单读出)、`/corrections`(人工纠错)、`/compare`(多商品对比)或任何 core `comparability` 能力——这些留给后续变更,待小程序需求明确后再做。`product_raw`/`product`/`unit_price` 之外**禁止**新建表或品类结构。

#### 场景:不引入读出/对比端点
- **当** 应用本变更后检查 `apps/api` 路由
- **那么** 仅存在 `/health`、`/parse`、`/contribute`、`/ingest`、`/ingest/batch`(写入路径端点),**不存在** `/rankings`/`/corrections`/`/compare`

## 新增需求

### 需求:POST /ingest/batch 批量异步采集端点

`apps/api` **必须**提供 `POST /ingest/batch`,用于一次上报**多条**商品的众包采集(降低逐条 HTTPS 握手开销,服务客户端在受限执行窗口内的批量 backfill)。它沿用 `/ingest` 的**异步**语义:逐条**同步**落 `product_raw` 后**立即**返回 `202`,把每条的 tier2 解析与单价计算移出请求路径(后台 `ctx.waitUntil`)。`/ingest`、`/contribute` **保持不变**,三端点并存。

请求体**必须**为 `BatchIngestRequestSchema = z.object({ items: z.array(ContributeRequestSchema).min(1).max(MAX_BATCH) })`——`items` 是**单条** `ContributeRequestSchema`(同一份 Zod SOT,**不**新增重复单条 schema)的数组,长度 `1..MAX_BATCH`。**`MAX_BATCH` 默认取 `40`**(免费计划 Worker 子请求上限 50 留余量——见下「子请求预算」);**调高到 100+ 须先确认生产 Worker 为付费计划(1000 子请求上限),作为显式部署前置、不得 defer**。校验**严格**:非 JSON / 非 `{ items: [...] }` / 空数组 / 超 `MAX_BATCH` / **任一条目不合 `ContributeRequestSchema`** → `400 invalid-request`,**禁止**写任何行、**禁止**排程任何后台解析。

编排顺序**必须**为:校验信封 → 取 repository → **同步逐条** `upsertRaw` 落 `product_raw`(经**强制共享**的落地映射 helper,与 `/ingest` **同一**份字段映射,**禁止**在 handler 内联复制)→ 对落地成功的条目排程**单个有界并发**后台解析单元 → `accepted≥1` 时**立即** `202`。后台单元**必须**用固定并发池(`BG_POOL`,如 5)消费落地条目,每条跑与 `/ingest` 后台 `run` 同逻辑(`orchestrate` → `ok` 则 `saveParsed`,自包 try/catch、失败仅 log、一条**不连累**其余)。**禁止**对每条各排程一个 `waitUntil`——那会瞬间派 `MAX_BATCH` 个并发后台单元、对 LLM/D1 形成**无界并发**;**必须**收敛为单个 `waitUntil(后台池)`、并发钉在 `BG_POOL` 以内。该端点**禁止**在 API 层重写任何解析或计算(tier 边界同 `/ingest`)。受 `api-governance` 治理(纳入受保护端点集合,须**自行**挂治理中间件——Hono 精确路径匹配,`/ingest` 的中间件不套住 `/ingest/batch`)。

**子请求预算**:单次请求后台 LLM fetch 总数 = 落地条目中触达 tier2 的条数 ≤ `MAX_BATCH`,计入该 Worker invocation 的子请求上限;`BG_POOL` 限**并发**、不减**总量**,故子请求总量由 `MAX_BATCH` 守、并发风暴由 `BG_POOL` 守(两个独立约束)。

响应**必须**为 `BatchIngestResponseSchema = z.object({ accepted: int≥0, failed: Array<{ index: int≥0, store: string, storeSku: string }> })`:`accepted` = 成功 `upsertRaw` 落地并纳入后台解析的条数;`failed` = 失败条目的 `{ index, store, storeSku }` 列表(`index` = 该条在请求 `items` 数组中的**原始下标**,供客户端**精确定位**失败条、选择性重试)。**不变量**:`accepted + failed.length === items.length`(逐条一一对应、**不去重**)。**失败条目必须用 `index` 标识、不可仅返裸 `storeSku`**:同批「跨 store 同 `storeSku`」或「同 `(store,storeSku)` 重复」时裸 `storeSku` 列表无法定位;`index` 在原数组唯一、消歧(`store`/`storeSku` 一并返供客户端键/日志)。

`/ingest/batch` 请求路径错误码集合**必须**为 `{ invalid-request(400), persistence-error(500), internal(500), accepted(202) }` 加治理码,**不含** `insufficient-information`/`config-error`(解析在后台、不影响 HTTP 状态)。状态判据:
- 信封非法 → `400`(无 raw 落地)。
- repo 未绑定/`resolveRepo` 抛错 → `500 persistence-error`(整批,无 raw 落地)。
- 信封合法、repo 解析成功但**全部**条目 `upsertRaw` 失败(`accepted=0`)→ **`500 persistence-error`**:`accepted=0` = 未落任何 raw,**禁止**返 2xx 把整批写失败伪装成已受理(与单条 `/ingest` 的 `upsertRaw` 失败→500 一致)。
- 信封合法、repo 解析成功、**`accepted≥1`** → `202`(**部分失败**即 `failed.length≥1` 仍 202,逐条失败由 body `failed: [{index,store,storeSku}]` 报告、不改 HTTP 状态、不回滚已落地条目)。
- `internal(500)`:响应自身校验失败的防御兜底(实质不可达)。
- raw 落地判据:`202` ⟺ `accepted≥1`;`accepted=0` 一律走 `500`、不返结果体。

**`config-error` 说明(同 `/ingest`)**:上面「不含 `config-error`」指**业务侧** config-error(LLM `OPENROUTER_API_KEY` 缺失)——它在**后台** `orchestrate` 才触发、不入请求路径码集。**治理侧** config-error(`api-governance` 的 `API_KEYS` 缺失,`500 config-error`)属上面「加治理码」的一部分、可在请求路径出现(治理中间件前置),与既有 `/ingest` 的「config-error 双源」框架(见 contribute-ingest §错误状态码可区分)一致——批量端点继承同一治理行为,不另立。

#### 场景:一批合法商品秒返 202 并逐条落地
- **当** 客户端携带合法 key,POST `{ items: [3 条合法商品] }` 到 `/ingest/batch`
- **那么** 服务**必须**对每条 `upsertRaw` 落 `product_raw`、排程**单个有界并发**后台解析单元、**立即**返回 `202` 与体 `{ accepted: 3, failed: [] }`,**不**在响应里返回解析结果(`spec`/`unitPrice` 等,后台尚未完成)

#### 场景:信封非法整批拒绝
- **当** 请求体非 JSON、或非 `{ items: [...] }`、或 `items` 为空数组、或长度超 `MAX_BATCH`、或**任一**条目缺 `store`/`storeSku`/`title` 或 `price` 非有限数
- **那么** 服务**必须**返回 `400 invalid-request`,**禁止**写任何行、**禁止**排程任何后台解析(整批拒,无部分落地)

#### 场景:单条落地失败不连累整批(accepted≥1 仍 202)
- **当** 一批 N 条(`N≥2`)信封合法、repo 已解析,其中某条 `upsertRaw` 抛错(偶发)、其余成功
- **那么** 服务**必须**仍对其余条目落地+纳入后台、返回 `202`,体 `accepted` 为成功条数(≥1)、`failed` 含该条 `{ index, store, storeSku }`(整批**不** 5xx、**不**回滚已落地条目);且 `accepted + failed.length === N`

#### 场景:全部条目落地失败报 persistence-error
- **当** 信封合法、repo 解析成功,但**全部** N 条 `upsertRaw` 失败(`accepted=0`,如 DB 写中途全失败)
- **那么** 服务**必须**返回 `500 persistence-error`(未落任何 raw,**禁止** 2xx 伪装成功),**不**返 `{accepted, failed}` 结果体

#### 场景:DB 未绑定整批报 persistence-error
- **当** 运行环境未注入 D1 binding,客户端 POST `/ingest/batch`
- **那么** 服务**必须**返回 `500 persistence-error`(整批,无 raw 落地),体**不含** `accepted`/`failed` 结果(走错误形态)

#### 场景:批量端点缺 key 被治理拒绝
- **当** 客户端**不带** key POST `/ingest/batch`
- **那么** `api-governance` **必须**拦截返回 `401`(确认批量端点确已自挂治理中间件、未因路径而漏挂),**禁止**进入业务、**禁止**落任何行
