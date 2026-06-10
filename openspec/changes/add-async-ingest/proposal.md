## 为什么

众包数据源是一个 **Surge 插件**(MITM 山姆 App 商品列表接口,对每个商品 `POST /contribute` 上报,带用户手填 API key)。现有 `/contribute` 在请求路径里**同步**跑 tier2 LLM(~3–5s),导致 Surge 脚本在山姆响应里等太久、**经常超时**、并拖慢 App 的商品列表加载(真机实测脚本耗时 4.9s 撞客户端阻塞上限)。

要把慢的解析**移出请求路径**:采集端点**快速落 raw 后立即返回**,tier2 解析 + 单价计算在服务端**异步**完成。raw(原始观察)是最珍贵的众包资产,只要它同步落库,解析晚一点完成不影响数据沉淀——这是「观测优先」的自然延伸。

## 变更内容

- **新增 `POST /ingest` 异步采集端点**:`upsertRaw` 同步落 `product_raw` 成功后**立即返回 `202 {rawId}`**(不返回解析结果);`orchestrate`(tier1+tier2+tier3)+ `saveParsed` 经 `c.executionCtx.waitUntil(...)` 在**同一次 Worker 调用内后台执行**。事件驱动、每条只解析一次(无轮询、不反复烧 LLM)。
- **后台执行抽成可注入端口**(与 `makeLlm`/`makeRepo`/`governance` 同范式):生产注入 `waitUntil` 版,Node dev 无 `executionCtx`(getter 会 throw)注入**同步 await** 版,测试可断言。`/ingest` 路由**禁止**裸调 `c.executionCtx`。
- **`/contribute` 同步契约不变**:两端点并存,服务两类客户端——`/ingest` 给「只管快报、不要实时结果」的 Surge;`/contribute` 给未来「要当场看真实单价」的小程序/插件。
- **治理覆盖 `/ingest`**:纳入受保护端点集合(鉴权 + 限频 + 用量),中间件先于 handler 注册;**不做无鉴权公开端点**。限频在入口兜住后台 LLM 总量(每条只触发一次后台解析)。
- **后台失败去向**:`insufficient`(如「饮用天然水」无规格)/`config-error`/`saveParsed` 抛错 → 只打结构化日志、**不重试、不重烧 LLM**,raw 保留为「有 raw 无 product」中间态(与现有 spec 有意接受的中间态同质,`getProduct` 只查有 product 的行不受影响)。

## 功能 (Capabilities)

### 新增功能
<!-- 无新建 capability;/ingest 作为 contribute-ingest 能力的增量需求引入 -->

### 修改功能
- `contribute-ingest`: 新增「POST /ingest 异步采集端点」需求——复用 `ContributeRequestSchema`(单条,不批量)、`202 {rawId}` 成功响应(过最小 `IngestResponseSchema` 校验)、错误码集合(请求路径只 `400`/`401`/`403`/`429`/`500 persistence-error`/`202`,无 `503`)、`executionCtx` 注入端口与 Node dev 同步降级、后台 `orchestrate`+`saveParsed` 执行与三态失败去向(日志/不重试/不重烧)。明确 `/contribute` 同步契约不变、两端点并存。
- `api-governance`: 受保护端点集合从 `{/parse, /contribute}` 扩展为 `{/parse, /contribute, /ingest}`——`/ingest` 同样要求合法 API key、计入限频与用量、超限/缺 key 时禁止进入 ingest 流水(禁止 `upsertRaw`、禁止触发后台解析);`/health` 仍豁免;鉴权/限频/用量/挂载顺序四条需求按集合泛化。既有第 5 条需求「真实治理初始化校验 API_KEYS」**端点无关**(只管 init 期配置校验、不引用受保护端点集合),集合扩展不改其语义,故 delta **不复述**(OpenSpec delta 只列 MODIFIED 需求;未改需求不复述,非遗漏)。

## 影响

- **代码**:`apps/api/src/routes.ts`(新增 `/ingest` 路由 + `IngestResponseSchema` + 治理挂载,复用 `ContributeRequestSchema`/`upsertRaw`/`orchestrate`/`saveParsed`)、`apps/api/src/index.ts`(`AppDeps` 增「后台执行」注入端口 + `buildApp` wire `waitUntil` 版)、`apps/api/src/server.ts`(Node dev 注入同步版)、可能 `apps/api/src/worker.ts`(`ctx` 已透传,通常无需改)。
- **复用不改**:`packages/core`、`packages/db`(repository 契约不变)、`orchestrate.ts`、`governance.ts`、`/contribute` 既有契约。
- **零运维增量**:无 D1 迁移、无新 binding、无 cron、无 `wrangler.toml` 改动、无 CI/`CLOUDFLARE_API_TOKEN` 权限增量——纯代码变更。
- **合规面**:众包上报(架构第七节「中」档),沿用现有治理 + 手填 key,**无新增爬取面**。
- **非目标(留后续独立变更)**:Queues/cron 批量重解析与瞬态失败的有界重试;批量 `/ingest/batch`;改 `/contribute` 为异步;无鉴权公开端点;schema/persistence 契约变更。
- **不在本提案范围(仅备注)**:Surge 插件(另仓)需换 path 到 `/ingest`、去掉客户端阻塞兜底,请求体一行不改。
