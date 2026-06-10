## 1. 后台执行注入端口

- [x] 1.1 `apps/api/src/routes.ts` 的 `AppDeps` 增加可选 `scheduleBackground?: (c, run: () => Promise<void>) => void | Promise<void>`(注释说明:生产 `c.executionCtx.waitUntil(run())`、Node dev/缺省同步 `run()`;路由禁止裸调 `c.executionCtx`)
- [x] 1.2 `apps/api/src/index.ts` 的 `buildApp()` wire `scheduleBackground: (c, run) => c.executionCtx.waitUntil(run())`(生产 waitUntil 版;闭包在**调用时**收每请求的 `c`,非 build 时解析)。该端口**必须返回 void**(`waitUntil` 返 void),使 handler 的 `await` 立即 resolve、`202` 秒返、不阻塞于 `run()`
- [x] 1.3 `apps/api/src/server.ts`(Node dev)不注入 `scheduleBackground` 也不注入 `makeRepo`,故本地 `/ingest` 在 `resolveRepo` 即 `500 persistence-error`(无 D1)、**不进后台**;后台同步路径仅由单测注入 in-memory repo + 同步端口覆盖。确认本地 `/parse` 仍正常、`/ingest` 走 persistence-error

## 2. /ingest 请求/响应 schema + 公共 helper

- [x] 2.1 `routes.ts` 复用既有 `ContributeRequestSchema`(不新增重复 schema);定义 `IngestResponseSchema = z.object({ rawId: z.string().min(1) })`
- [x] 2.2 抽公共内部 helper:`parseContributeBody`(非 JSON/schema 失败 → 400 invalid-request)、`resolveRepo`(try `makeRepo`,null/抛错 → 500 persistence-error)、`landRaw`(`upsertRaw` → rawId,抛错 → 500 persistence-error),供 `/contribute` 与 `/ingest` 共用,降重复且保持 `/contribute` 行为不变

## 3. /ingest 路由编排

- [x] 3.1 **先** `app.use('/ingest', governanceMiddleware(deps.governance))`、**再** `app.post('/ingest', …)`(中间件先于 handler 注册,与 `/parse`/`/contribute` 同序)
- [x] 3.2 handler:`parseContributeBody`(400)→ `resolveRepo`(500 persistence-error)→ `landRaw` 取 `rawId`(500 persistence-error)
- [x] 3.3 组装后台 `run = async () => { orchestrate(input, makeLlm(env)); ok→saveParsed; insufficient→console.warn(rawId/store/sku); config-error→console.error; saveParsed 抛错→console.error; 整个 run 包 try/catch 防未捕获 }`——**不**重试
- [x] 3.4 `await (deps.scheduleBackground ?? ((_, r) => r()))(c, run)` 后,过 `IngestResponseSchema` 校验 `{ rawId }`(失败 → 500 internal),返回 `202`
- [x] 3.5 确认 `/ingest` 请求路径错误码集合 = `{invalid-request, persistence-error, internal, 202}` + 治理码,**不含** `insufficient-information`/`config-error`(后者只进后台日志)

## 4. apps/api 单测(注入同步后台端口 + in-memory repo)

- [x] 4.1 测合法上报 → `202` + `{rawId}`;注入**同步**后台端口 + better-sqlite3 内存 repo,断言后台跑完后 `product_raw`/`product`/`unit_price` 各落一行
- [x] 4.2 测缺/空/纯空白 `store`/`storeSku`、空 `title`、非有限 `price` → `400 invalid-request`,未写任何行、未排程后台
- [x] 4.3 测 `makeRepo` 返回 null(无 DB)→ `500 persistence-error`,体不含 `rawId`,未排程后台
- [x] 4.4 测后台 `insufficient`(LLM stub 返 transport 失败 + 无 shape 标题)→ 仍 `202`+rawId;后台跑完后 `product_raw` 有行、`product` 无行(有 raw 无 product),且 LLM stub **只被调一次**(spy 断言不重试)
- [x] 4.5 测后台 `config-error`(LLM stub 返 `{ok:false,kind:'config'}` + **非 tier1-determinate 标题**使 orchestrate 进 tier2)→ 仍 `202`;后台不 saveParsed(查 `product` 表空)、不重试
- [x] 4.5b 测后台 `saveParsed` 抛错(注入同步后台端口 + upsertRaw 正常、saveParsed `vi.fn` 抛错的 repo;干净 tier1-可算标题走 ok 分支到 saveParsed)→ 仍 `202`+rawId。**观测「后台失败」靠查终态、不靠捕异常**(run 自包 try/catch 吞错故 reject 不可得):断言后台跑完后 `product_raw` 有行、`product` 无行(有 raw 无 product)、`saveParsed` spy **只被调一次**(不重试)
- [x] 4.6 测不可计算商品(`ok` 但 `per100ml=null`)→ `202`;后台落 `product`+`unit_price`,`unit_price.per100ml` 为 NULL
- [x] 4.7 测「永不 503」**非恒真**:必须各构造一条**后台会 insufficient**(无 shape 标题 + transport 失败 stub)与**会 config-error**(非 determinate 标题 + config stub)的上报,断言其 HTTP **仍是 `202`**(而非 `503`/业务 `500 config-error`)——证明后台失败态不冒泡进请求路径(禁止用 ok 输入断言 `status!==503` 的恒真写法)
- [x] 4.8 测 `/contribute` 行为**不变**(回归:既有 `/contribute` 测试仍全绿,响应体 + 三 id 不变)

## 5. 治理覆盖 /ingest 的回归

- [x] 5.1 `governance.test.ts`(或 routes 测)补:`/ingest` 缺 key → `401 auth-missing`,且**禁止** `upsertRaw`/LLM/后台排程(spy 断言未调用)
- [x] 5.2 补:`/ingest` 未登记 key → `403 auth-forbidden`;合法 key → 放行(`202`)且该 key 的 usage 计数**恰增 1**(放行即计一次,不被后台重复计数);超限 → `429` 且不落 raw/不排程后台;`/health` 仍豁免
- [x] 5.3 `worker.test.ts` 入口级:确认生产 `buildApp()` 对 `/ingest` 挂的是真实治理(沿用 wide-open guardrail 断言模式);并用 `vi.fn` 的 `ctx.waitUntil` 断言一条合法 `/ingest` 上报使 `ctx.waitUntil` **被调一次**(证明生产确为 waitUntil 版,非缺省同步)
- [x] 5.4 测生产端口**非阻塞**(守住「秒返」性能契约,防回归悄悄重引超时):**必须注入 fire-and-forget 测试端口** `scheduleBackground = (_, run) => { void run(); }`(调 run 但**不 await**,模拟生产 waitUntil 不等待语义)+ 一个**永不 resolve** 的 `run`,断言 `/ingest` 仍**立即**返回 `202`——证明 `await scheduleBackground` 不阻塞于后台解析。**禁止**用缺省/同步端口跑本测试(同步 `await run()` 遇永不 resolve 的 run 会让测试自锁卡死)

## 6. 收尾

- [x] 6.1 `pnpm --filter @unit-price/api test` + `pnpm --filter @unit-price/api build`(`tsc -b` 类型检查)全绿
- [x] 6.2 `openspec-cn validate add-async-ingest --strict` 通过
- [x] 6.3 `apps/api/README.md` 补 `/ingest` 端点(用途、请求体同 `/contribute`、`202 {rawId}`、错误码不含 503、后台异步解析说明);治理小节受保护端点集合更新为 `{/parse, /contribute, /ingest}`

## 7. 部署后端到端验证

- [ ] 7.1 部署 preview 后,带合法 key `curl POST /ingest` 一条山姆样本,确认**秒返** `202 {rawId}`(明显快于 `/contribute`);稍候查 preview D1 `product`/`unit_price` 后台已落行 [手动验证]
- [ ] 7.2 prod 经 push main 自动部署后,同样 `curl /ingest` 抽验 `202` + 后台落库 [手动验证]
- [ ] 7.3 Surge 插件(另仓)换 path 到 `/ingest`、去掉客户端阻塞兜底,真机验证不再超时 [手动验证·另仓]
