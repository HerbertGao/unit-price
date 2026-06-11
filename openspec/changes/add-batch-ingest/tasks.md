## 1. schema(apps/api/src/routes.ts）

- [x] 1.1 新增 `MAX_BATCH = 40` 常量(注释:免费计划 Worker 子请求上限 50 留余量;**调高到 100+ 须先确认生产 Worker 为付费计划(1000 子请求),作为显式部署前置**)+ `BG_POOL = 5` 常量(后台解析并发上限)
- [x] 1.2 新增 `BatchIngestRequestSchema = z.object({ items: z.array(ContributeRequestSchema).min(1).max(MAX_BATCH) })`(复用既有单条 `ContributeRequestSchema`,**不**重复定义单条字段)+ `export type BatchIngestRequest`
- [x] 1.3 新增 `BatchIngestResponseSchema = z.object({ accepted: z.number().int().nonnegative(), failed: z.array(z.object({ index: z.number().int().nonnegative(), store: z.string(), storeSku: z.string() })) })` + `export type`;在 `apps/api/src/index.ts` 导出两个新 schema(与既有 schema 导出同风格)

## 2. 治理:用量按条 + Hono Variables 类型基建(apps/api/src/governance.ts + routes.ts）

- [x] 2.1 `recordUsage` 加可选 `amount` —— **三处同改**:(a) `Governance` interface 的 `recordUsage(env, key, amount?: number): Promise<void>` 类型声明(`governance.ts:55`);(b) 真实实现(`:174`)累计 `count` 增量从 `+1` 改为 `+ (amount ?? 1)`;(c) no-op 实现(`:224`)同步加形参(本就忽略入参)。默认 1、**向后兼容**
- [x] 2.2 **Hono Variables 类型基建(漏改即 build 红)**:在 **`bindings.ts`**(routes 与 governance 都已 import Bindings 的共享叶子)定义 `type AppEnv = { Bindings: Bindings; Variables: { govKey: string } }`(放 routes.ts 会迫使 governance 反向 import、反转依赖方向),把 **全部**站点统一切到 `AppEnv`:`createApp` 的 `new Hono<…>`、`parseContributeBody`/`resolveRepo`/`landRaw` 的 `Context<…>`、`AppDeps.scheduleBackground` 参数里的 `Context<…>`、`governance.ts` 的 `MiddlewareHandler<…>`。**禁止** `as string` 容错(绕过类型保护、违 SOT)
- [x] 2.3 `governanceMiddleware` 在 `authenticate` 通过后 `c.set('govKey', auth.key)`;仍 `recordUsage(env, auth.key)` 计 1(准入基线,amount 默认 1,行为不变)
- [x] 2.4 确认 `recordUsage` 的 `amount` 仍受「仅元数据、失败只告警、不抛、不改响应」约束;handler 侧 guard `accepted>1` 确保绝不传 `amount≤0`(防 KV `count` 被减损坏)

## 3. 批量端点 handler(apps/api/src/routes.ts）

- [x] 3.1 抽**强制共享**落地 helper `upsertRawOrNull(repo, req): Promise<string|null>`(try `upsertRaw` 返 rawId / catch 返 null);`landRaw` 改为 `upsertRawOrNull` + 失败包 500 response 的薄封装,**字段映射只此一处**;批量与 `landRaw` 都经它,**禁止**在批量 handler 内联复制 `upsertRaw({...})` 字段映射(防 `/ingest` 与批量落地漂移)
- [x] 3.2 `app.use('/ingest/batch', governanceMiddleware(deps.governance))` + `app.post('/ingest/batch', ...)`,**紧挨 `/ingest` 注册之后**(Hono 精确匹配,`/ingest` 中间件不套住 `/ingest/batch`,批量须自挂治理)
- [x] 3.3 信封校验:`c.req.json()`(非 JSON→400 invalid-request)→ `BatchIngestRequestSchema.safeParse`(失败→400,含 issues)。`resolveRepo`(复用)→ null/throw→500 persistence-error(整批,无 raw 落地)
- [x] 3.4 **同步逐条落地**:对 `items` 每条 `const rawId = await upsertRawOrNull(repo, item)`;成功→`accepted++`、收集 `landed.push({rawId, req: item})`;失败(null)→`failed.push({ index, store: item.store, storeSku: item.storeSku })`。`accepted + failed.length === items.length`
- [x] 3.5 **单个有界并发后台单元**(修无界并发):若 `accepted ≥ 1`,**只调一次** `await (deps.scheduleBackground ?? sync)(c, () => drainBackground(landed, BG_POOL))`。`drainBackground` 用固定并发池(`BG_POOL`)消费 `landed`,每条跑与 `/ingest` 后台 `run` 同逻辑(`orchestrate`→`ok` 则 `saveParsed`,自包 try/catch 仅 log、一条不连累其余)。**禁止**对每条各调一次 `scheduleBackground`(无界并发)
- [x] 3.6 用量叠加:`const key = c.get('govKey'); if (accepted > 1) await deps.governance.recordUsage(c.env, key, accepted - 1);`(总用量=accepted;`accepted≤1` 不叠加、不传负 amount)。叠加失败不抛、不改响应
- [x] 3.7 **状态码**:`accepted = 0`(全部条目 `upsertRaw` 失败)→ `500 persistence-error`、**不**返结果体(与单条 `/ingest` upsertRaw 失败→500 一致,禁 2xx 伪装成功);`accepted ≥ 1` → 组装并校验 `BatchIngestResponseSchema.safeParse({accepted, failed})`→ 失败 `500 internal`(防御兜底)→ 成功 `c.json(validated.data, 202)`
- [x] 3.8 确认 `/ingest`、`/contribute`、`/parse` handler **零改动**(批量纯新增;`landRaw` 经 3.1 重构后行为对 `/ingest`/`/contribute` 不变——须回归)

## 4. 单测(apps/api）

- [x] 4.1 合法批量:POST `{items:[3 条合法]}` → 202 `{accepted:3,failed:[]}`;断言 `upsertRaw` 调 3 次、`scheduleBackground`(同步注入)调**一次**(单个后台单元、非 3 次)、`saveParsed` 按 orchestrate ok 落 3 次
- [x] 4.2 信封非法整批拒:非 JSON→400;`{items:[]}`(空)→400;`items` 超 `MAX_BATCH`→400;`items` 含一条缺 `storeSku`→400(整批拒、`upsertRaw` 零调用)
- [x] 4.3 部分失败 accepted≥1 仍 202:mock `upsertRaw` 对第 2 条(共 3 条)抛错、其余成功 → 202 `{accepted:2, failed:[{index:1, store, storeSku}]}`(第 2 条 index=1),其余两条纳入后台;断言 `accepted+failed.length===3`
- [x] 4.4 **全失败 accepted=0 → 500**:mock `upsertRaw` 对全部条目抛错 → `500 persistence-error`、**不**返 `{accepted, failed}` 结果体(禁 2xx 伪装)
- [x] 4.5 DB 未绑定:`makeRepo` 返 null → 500 persistence-error(整批,resolveRepo 阶段)
- [x] 4.6 治理:`/ingest/batch` 不带 key → 401(确认批量端点自挂治理、未漏挂);带合法 key 放行
- [x] 4.7 用量按条:合法 N(≥2)条 → `recordUsage` 总增量 = N(中间件 1 + 叠加 N-1);N=1 → 增量 1(不叠加);全失败 accepted=0(走 500)→ 增量 1(仅准入,无 `amount≤0` 调用)。mock governance 断言 `recordUsage` 各次 amount 之和 + 绝无 amount≤0
- [x] 4.8 限频按请求:一次大批量(如 40 条)只消耗 1 个 rate token(`checkRateLimit` 调 1 次),不因条数放大
- [x] 4.9 **后台有界并发**:注入一个记录并发峰值的 `scheduleBackground`/orchestrate mock(或计数 in-flight),POST 一批 `accepted = MAX_BATCH` → 断言后台并发 in-flight ≤ `BG_POOL`(证明非无界 N 并发);`scheduleBackground` 调用 1 次
- [x] 4.10 **路由集合(必改、非选改)**:`contribute.test.ts:436` 的 `expect(paths).toEqual(['/contribute','/health','/ingest','/parse'])`(`toEqual` 全等)更新为 `['/contribute','/health','/ingest','/ingest/batch','/parse']`(排序后);确认 `/ingest`/`/contribute`/`/parse` 行为回归不变(尤其 `landRaw` 经 3.1 重构后)

## 5. 收尾

- [x] 5.1 `pnpm --filter @unit-price/api test` + `pnpm --filter @unit-price/api build` 全绿(含 Hono `AppEnv` 类型通过、`c.set/get('govKey')` 无 TS 报错)
- [x] 5.2 `pnpm -r test` + `pnpm -r build` 全绿
- [x] 5.3 (部署确认)核对生产 Worker 计划:`MAX_BATCH=40` 在免费计划 50 子请求内可安全上线;若确认付费计划(1000)再按需调高常量;wrangler dry-run 不报错
- [x] 5.4 `openspec-cn validate add-batch-ingest --strict` 通过
