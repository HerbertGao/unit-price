## 上下文

`POST /contribute`(`routes.ts`)在请求路径里同步跑 `upsertRaw → orchestrate(tier1+tier2 LLM+tier3) → saveParsed → 返回完整解析结果`。众包数据源 Surge 插件对每个山姆商品调它,tier2 LLM ~3–5s 使 Surge 脚本在山姆响应里等太久、经常超时。需把解析移出请求路径:采集端点落 raw 后秒返,解析异步完成。

既有可复用事实(实读代码):
- `AppDeps`(`routes.ts`)已是「按请求从 `c.env` 构造端口」范式:`makeLlm`、`makeRepo?`、`governance`。`buildApp()`(生产)wire 真实实现,`server.ts`(Node dev)省略 `makeRepo`、注入 no-op 治理。
- `worker.ts:21` 已把 Workers `ctx` 透传给 `app.fetch(request, env, ctx)`,故 Hono `c.executionCtx`(getter,Hono 4.12.25 返回含 `waitUntil` 的 `ExecutionContext`)在生产路径**可达**;但该 getter 在无执行上下文时(Node dev `server.ts`)会 **throw**。
- `orchestrate(input, llm)` 返回 `{ kind:'ok'|'insufficient'|'config-error', response? }`;`saveParsed({rawId,spec,calc})` 的 `calc = {unitPrice,confidence,warnings}`。
- `ContributeRequestSchema`(`routes.ts`,`store`/`storeSku` 已 `trim().min(1)`)、`governanceMiddleware`、`upsertRaw` 的 `(store,store_sku)` 幂等 upsert 全部可直接复用。

## 目标 / 非目标

**目标:**
- `POST /ingest`:`upsertRaw` 同步落 raw → 立即 `202 {rawId}`;`orchestrate+saveParsed` 经注入的「后台执行端口」异步跑。
- 后台执行抽成可注入端口,生产用 `waitUntil`、Node dev 同步降级、测试可断言;路由**禁止**裸调 `c.executionCtx`。
- `/ingest` 纳入 `api-governance` 受保护端点集合。
- `/contribute` 同步契约、spec、测试**零改动**。

**非目标:**
- Queues/cron 批量重解析、后台瞬态失败的有界重试(留后续独立变更)。
- 批量 `/ingest/batch`;无鉴权公开端点;改 `/contribute` 为异步;schema/persistence/wrangler/CI 变更。

## 决策

**D1:后台执行抽成 `AppDeps.scheduleBackground?` 注入端口,而非路由内裸调 `c.executionCtx`。**
签名:`scheduleBackground?: (c, run: () => Promise<void>) => void | Promise<void>`。
- 生产(`buildApp`)注入:`(c, run) => { c.executionCtx.waitUntil(run()); }`——返回 void,`run()` 经 waitUntil 在响应发出后于同一次调用内继续。
- Node dev(`server.ts`)与缺省:`(c, run) => run()`——返回 promise,handler `await` 它,使 dev/测试**同步、确定**(202 在解析完成后发出);用于「断言后台落库」的测试。
- 测试**第三态(fire-and-forget)**:`(_, run) => { void run(); }`——调 `run()` 但**不 await**,模拟生产 `waitUntil` 的「不等待后台」语义。专用于「非阻塞/秒返」断言(注入永不 resolve 的 `run`,202 仍立即返回)。**不能**用缺省同步端口跑非阻塞断言——同步 `await run()` 遇永不 resolve 的 run 会让测试自锁卡死。
- handler 统一 `await (deps.scheduleBackground ?? ((_, r) => r()))(c, run)` 后返回 202:生产/fire-and-forget `await` 立即 resolve(秒返)、dev 同步版 `await` 跑完解析。
理由:与 `makeLlm`/`makeRepo`/`governance` 同范式;把「`executionCtx` 在 Node dev 会 throw」这个坑收敛到注入边界,路由不感知运行时;测试可注入同步版断言后台落库。
- 备选(否决):路由内 `try { c.executionCtx.waitUntil(...) } catch { await ... }`。坑散落在路由、Node dev 行为靠 catch 兜、测试难断言后台是否真跑。

**D2:新增 `/ingest`,`/contribute` 不动(两端点并存)。**
`/contribute` 同步契约有完整 spec(13 场景)+ 测试,原地改异步会全部报废。两端点服务两类客户端:`/ingest` 给「只管快报」的 Surge、`/contribute` 给未来「要实时单价」的小程序。`/ingest` 复用 `ContributeRequestSchema`/`governanceMiddleware`/`upsertRaw`/`orchestrate`/`saveParsed`,增量仅一个路由 handler。

**D3:`202 {rawId}`,错误码集合比 `/contribute` 少 `503`。**
`upsertRaw` 成功即 `202`,其后的 `orchestrate`/`saveParsed` 失败发生在**后台**、不影响 HTTP。故请求路径错误码只有 `400 invalid-request`/`401`-`403` auth/`429 rate-limited`/`500 persistence-error`/`202`,**无** `insufficient-information`/`config-error`。raw 已落 ⇒ `202` 体附 `rawId`;raw 未落的错误(invalid-request、repo 不可用/upsertRaw 抛错的 persistence-error)不附。`202` 体过最小 `IngestResponseSchema = z.object({ rawId: z.string().min(1) })`,校验失败 → `500 internal`(rawId 来自 upsertRaw 恒非空,守 guard 一致性)。

**D4:后台三态失败去向——只日志、不重试、不重烧 LLM。**
`orchestrate` 返回:`ok` → `saveParsed` 落 product+unit_price;`insufficient`(如「饮用天然水」无规格)→ `console.warn`(rawId+store+sku),不 saveParsed;`config-error` → `console.error`;`saveParsed` 抛错 → `console.error`。三者均**不自动重试**——`waitUntil` 内无退避重试不安全,且事件驱动每条只解析一次,天然不反复烧 LLM。失败留「有 raw 无 product」中间态(与 `contribute-ingest` spec 既有「有意接受」同质,`getProduct` 只查有 product 的行)。后续补齐率以独立 Queues/cron 变更升级。

## 风险 / 权衡

- [best-effort:Worker 响应后被驱逐,个别 raw 后台解析没跑完] → raw 已同步落库不丢(最值钱资产保住),仅缺该条 product 补齐;与既有「有 raw 无 product」中间态同质;后续批量重解析可补。
- [`c.executionCtx` 在 Node dev throw] → 由 D1 注入端口收敛:生产注 `waitUntil` 版、dev 注同步版,路由不裸调;`worker.test.ts` 已能构造含 `waitUntil` 的 `ExecutionContext`,生产端口可测。
- [后台 tier2 仍烧 LLM,只是移出请求路径] → 由 `api-governance` 限频在**入口**兜住(每条只触发一次后台解析,管住入口即管住后台 LLM 总量)。
- [两端点重复编排逻辑] → 抽公共「校验体 → 取 repo → upsertRaw」步骤为内部 helper,`/contribute`(同步 saveParsed + 完整响应)与 `/ingest`(202 + 后台 saveParsed)只在「解析时机 + 响应」分叉,降重复。

## 迁移计划

1. `routes.ts`:`AppDeps` 加 `scheduleBackground?`;抽 `parseContributeBody`/`resolveRepo`/`landRaw` 内部 helper(`/contribute` 与 `/ingest` 共用);新增 `IngestResponseSchema`;挂 `app.use('/ingest', governanceMiddleware)` **先于** `app.post('/ingest')`;handler 落 raw → `await scheduleBackground(c, run)` → `202 {rawId}`。
2. `index.ts`:`buildApp` wire `scheduleBackground: (c, run) => c.executionCtx.waitUntil(run())`。
3. `server.ts`:不注入(走缺省同步版),本地 `/ingest` 同步跑完解析(无 D1 → 后台 saveParsed 因 repo 已在 landRaw 前判 null 而走 persistence-error,即 `/ingest` 在 dev 仍 `500 persistence-error`,与 `/contribute` 一致)。
4. 部署:push main 由 CI 自动 deploy,无迁移/binding/cron 增量。
5. 回滚:纯新增端点 + 一个可选注入端口;摘路由 + 端口即回现状,`/contribute` 与既有部署不受影响,无 D1/wrangler 状态需回退。

## 待解决问题

- 无阻塞性未决项。后台日志格式(结构化字段)沿用现有 `console.warn/error` 风格,不引入新日志框架。
