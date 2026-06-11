## 为什么

山姆 Surge 众包插件经 cron 后台逐条 `POST /ingest` 上报。Surge cron 脚本被硬卡 ~5s(`timeout=` 对 `type=cron` 无效,官方文档证实),而**每条上报一个独立 HTTPS 请求**(每次新 TLS 握手 ~0.45s),5s 内最多发十几条;重录后的积压(如 130 条)要好几个 cron tick 才排空。

`/ingest` 端点的契约里 line 104 当时显式写了「**单条**上报(本期**不**做批量 `/ingest/batch`)」——本变更补上它:一次请求传一批(≤MAX_BATCH,默认 40 条),**一个 TLS 握手落多条**,backfill 一个 tick 发完,公开分发的插件也更省电、对服务端更友好。

## 变更内容

- **新增 `POST /ingest/batch`**(异步、202),与 `/ingest` 同源、同理念:请求体含条目数组,每条 = `/ingest` 同样的 `ContributeRequestSchema`(`title`/`price`/`store`/`storeSku`/可选溯源)。服务端**同步逐条** `upsertRaw` 先落 `product_raw`,再用**单个**有界并发后台单元(`ctx.waitUntil` + 固定并发池 `BG_POOL`)逐条 `orchestrate`+`saveParsed`(已带去重),`accepted≥1` **立即返 202**,不阻塞等解析。
- **schema 复用、不重复**:`BatchIngestRequestSchema = z.object({ items: z.array(ContributeRequestSchema).min(1).max(MAX_BATCH) })`(同一 Zod SOT 包数组,**`MAX_BATCH=40`** 免费计划子请求安全默认,调高须确认付费计划)。超 `MAX_BATCH` / 空 / 非数组 / 任一条目不合 schema → `400 invalid-request`(整批拒,严格——插件本就只入队合法条目)。
- **helper 复用、字段映射不漂移**:复用 `parseContributeBody`/`resolveRepo`/`scheduleBackground`;落地经**强制共享** helper `upsertRawOrNull`(`landRaw` 与批量都走它,**禁止**在 handler 内联复制字段映射)。
- **逐条独立落地 + 有界后台并发**:每条 `upsertRaw` 独立(一条偶发抛错只计该条失败、不连累整批);后台解析**收敛为单个 `waitUntil` + `BG_POOL` 并发池**(**非**每条各派一个 `waitUntil`——那会瞬间形成 `MAX_BATCH` 个无界并发 LLM/D1 操作)。响应 `202 { accepted, failed: [{index,store,storeSku}] }`(不变量 `accepted+failed.length===items.length`)供插件据 `index` 精确出队。
- **全失败走 500**:`accepted=0`(全部条目 `upsertRaw` 失败、未落任何 raw)→ `500 persistence-error`(与单条 `/ingest` 一致,**禁** 2xx 伪装成功);`accepted≥1` → 202(部分失败由 body 报告)。
- **治理:鉴权同 `/ingest`;限频按请求(1 批 1 token,payload 受 `MAX_BATCH` 约束);用量准入恒计 1 基线 + 落地条数叠加**(N 条算 N,不让批量绕过用量统计)——`recordUsage` 加可选 `amount`(向后兼容),中间件计 1(准入)、批量 handler 在 `accepted>1` 时叠加 `accepted-1`。需配套 Hono `Variables` 类型基建(`govKey` 暴露给 handler)。
- **`/ingest`、`/contribute` 不动**:批量是新增端点,旧端点行为零变化,三端点并存(`landRaw` 经 `upsertRawOrNull` 重构后行为对其不变)。

## 功能 (Capabilities)

### 新增功能
<!-- 无新建 capability;作为 contribute-ingest / api-governance 的增量需求引入 -->

### 修改功能
- `contribute-ingest`: 新增「`POST /ingest/batch` 批量异步采集端点」需求,并把既有 `POST /ingest` 需求里「本期不做批量 `/ingest/batch`」一句更新为「批量端点由 add-batch-ingest 提供」。批量端点复用单条 `ContributeRequestSchema`(数组包裹)+ `landRaw`/`scheduleBackground`,逐条独立落地+后台解析,立即 202。
- `api-governance`: 把 `/ingest/batch` **纳入受保护端点集合**——MODIFY 鉴权、中间件挂载顺序、限频、用量四需求,使集合从 `{/parse, /contribute, /ingest}` 扩为 `{/parse, /contribute, /ingest, /ingest/batch}`(否则 contribute-ingest 声称受治理与 api-governance 的保护集矛盾)。鉴权/中间件序同既有(批量须**自挂**治理、Hono 不套);限频**按请求**计(1 批 1 token,受 `MAX_BATCH` 约束);用量 `recordUsage` 加可选 `amount`(默认 1、向后兼容),批量按**准入 1 + 落地条数叠加**计。

## 影响

- **代码**:`apps/api/src/routes.ts`(新增 `BatchIngestRequestSchema` + `BatchIngestResponseSchema` + `POST /ingest/batch` handler,挂 `governanceMiddleware`)、`apps/api/src/governance.ts`(`recordUsage` 加 `amount` 参数 + 中间件暴露 `auth.key` 供 handler 补计)、`apps/api/src/index.ts`(导出新 schema)、`apps/api` 测试。
- **不触碰**:tier1/tier2/计算层与去重(`saveParsed` 已去重);`/ingest`、`/contribute`、`/parse` 既有行为;`packages/*`;抓取/众包合规面。
- **配套(本变更外)**:Surge 插件(`/Users/herbertgao/VSCodeProject/Scripts`)`drain` 改用 `/ingest/batch`(一次发一批、据 `failed` 的 `index` 选择性出队)——属 Scripts 仓后续,不在本 OpenSpec 变更内。
- **非目标**:不引入读出/对比/榜单端点;不改 tier 边界;不引入服务端主动爬取;不做「批量内跨条目事务」(逐条独立、观察优先,与 `/ingest` 单条同理念)。
