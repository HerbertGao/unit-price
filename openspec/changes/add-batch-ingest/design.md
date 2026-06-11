## 上下文

`apps/api/src/routes.ts` 现状:
- 三个受治理端点 `/parse`、`/contribute`、`/ingest`,各自 `app.use('<path>', governanceMiddleware(deps.governance))` 挂在 handler **之前**(Hono 按注册序匹配)。
- helper:`parseContributeBody`(body→`ContributeRequestSchema`,失败 400)、`resolveRepo`(repo null/throw→500 persistence-error)、`landRaw`(单条 `upsertRaw`,throw→500)。
- `/ingest`(line 363):preamble(parseBody→resolveRepo→landRaw)→ 组装 background `run`(`orchestrate`+`saveParsed`,自包 try/catch)→ `await (deps.scheduleBackground ?? sync)(c, run)` → 校验 `IngestResponseSchema({rawId})` → `202`。
- 治理 `governanceMiddleware`(`governance.ts`):`authenticate`→`checkRateLimit`(KV 计数,每请求 +1)→`recordUsage(env, key)`(KV `usage:<key>` 的 `count` +1,metadata-only、不阻塞)→`next()`。`recordUsage` 当前**按请求 +1**。
- schema SOT 在 `routes.ts`:`ContributeRequestSchema`(line 48)、`IngestResponseSchema = z.object({ rawId: z.string().min(1) })`(line 85);由 `index.ts` 导出。

## 目标 / 非目标

**目标:** 新增 `POST /ingest/batch`,一次落多条、立即 202、后台逐条解析;复用既有 helper 与 schema(数组包单条);用量按条计、限频按请求;`/ingest`、`/contribute` 零变化。

**非目标:** 不改 tier1/2/计算/去重;不做批内跨条目事务(逐条独立);不动其它端点;插件改造另算。

## 决策

**D1:新端点 `POST /ingest/batch`,异步语义同 `/ingest`。**
挂 `app.use('/ingest/batch', governanceMiddleware(deps.governance))`(handler 前,与其它端点一致)。**注册序**:`/ingest/batch` 的 `use`+`post` 须与 `/ingest` 的注册**不冲突**——Hono 精确路径匹配,`/ingest` 与 `/ingest/batch` 是不同路径、互不遮蔽;但为稳妥,`/ingest/batch` 的 `use`/`post` 紧挨 `/ingest` 之后注册。handler:校验信封 → resolveRepo → 同步逐条落地(收集 `landed`)→ **单个** `scheduleBackground(后台并发池)` → `accepted≥1` 时叠加用量并返 202(`accepted=0` 走 500)。

**D2:请求 schema = 数组包单条(严格),响应 schema 报落地结果。**
- `BatchIngestRequestSchema = z.object({ items: z.array(ContributeRequestSchema).min(1).max(MAX_BATCH) })`,**`MAX_BATCH = 40`**(免费计划 Worker 子请求上限 50 留余量——见 R1;插件实发 ≤50 须分块到 ≤MAX_BATCH)。**严格**:非 JSON / 非 `{items:[...]}` / 空 / 超 `MAX_BATCH` / **任一条目不合 `ContributeRequestSchema`** → `400 invalid-request`(整批拒)。理由:插件 `pickPriceCents` 只入队合法 `title`+`cents`,坏条目近乎不可能;严格校验最简、复用 SOT、无「部分坏条目」歧义;真有坏数据时整批 400,插件可丢该批(由插件侧决定)。
- `BatchIngestResponseSchema = z.object({ accepted: z.number().int().nonnegative(), failed: z.array(z.object({ index: z.number().int().nonnegative(), store: z.string(), storeSku: z.string() })) })`。`accepted`=成功 `upsertRaw` 落地并纳入后台解析的条数;`failed`=失败条目的 `{ index, store, storeSku }` 列表(`index`=该条在请求 `items` 数组中的**原始下标**,供客户端**精确定位**并选择性出队/重试)。**不变量**:`accepted + failed.length === items.length`(逐条一一对应、**不去重**)。**用 `index` 而非裸 `storeSku`**(修正 Codex P1):仅返 `storeSku` 列表在「同批跨 store 同 `storeSku`」或「同 `(store,storeSku)` 重复」时**无法**让客户端定位失败条(且 round-1 曾说「按 (store,storeSku) 对消」却没返 `store`,自相矛盾);`index` 在原数组中唯一,消歧。`store`/`storeSku` 一并返,供客户端日志/出队键。
- 备选(否决):宽松逐条校验 + `skipped` 计数。否决——插件不发坏条目,宽松增加 per-item safeParse 与「skipped vs failed vs accepted」三态复杂度,收益≈0;严格 + landed/failed 二态已够。

**D3:同步逐条落地 + 单个有界并发后台单元,复用 helper(强制共享落地映射)。**
信封校验通过 + repo 解析成功后:
- **同步逐条落地**:`items.forEach((item, index) => ...)` 逐条 `upsertRaw`,收集 `landed: Array<{ rawId, req }>` 与 `failed: Array<{ index, store, storeSku }>`。落地用**强制共享** helper `upsertRawOrNull(repo, req): Promise<string | null>`(try `upsertRaw` 返 rawId、catch 返 null);`landRaw` 与批量**都**经此 helper,**禁止**在批量 handler 内联复制 `upsertRaw({...})` 的字段映射(否则 `/ingest` 与批量落地逻辑静默漂移——Codex 点名)。`landRaw` 改为 `upsertRawOrNull` + 失败时包 500 response 的薄封装,字段映射只此一处。
- **单个有界并发后台单元**(**修正 Codex「无界并发」blocker**):**禁止**对每条各调一次 `scheduleBackground`(那会瞬间派 `MAX_BATCH` 个并发 `waitUntil`、对 LLM/D1 形成并发风暴、且无上界)。改为**只调一次** `scheduleBackground(c, () => drainBackground(landed, BG_POOL))`——`drainBackground` 用**固定并发池**(`BG_POOL = 5`)顺序消费 `landed`,每条跑与 `/ingest` 相同的 `run` 逻辑(`orchestrate`→`ok` 则 `saveParsed`,自包 try/catch、失败仅 log、一条不连累其余)。生产 = 单个 `ctx.waitUntil(drainBackground(...))`,池把并发 LLM/D1 操作钉在 `BG_POOL` 以内。
- 落地失败(null)→ `failed.push({ index, store: req.store, storeSku: req.storeSku })`,不进 `landed`。
- **子请求总量**:后台总 LLM fetch 数 = `landed` 中触达 tier2 的条数 ≤ `MAX_BATCH`(`BG_POOL` 限**并发**、不减**总量**);`MAX_BATCH=40` 把单次 invocation 的子请求总量钉在免费计划 50 上限内(见 R1)。`BG_POOL` 限并发风暴(LLM 速率/成本、D1 并发),与子请求总量是**两个独立约束**,分别由 `BG_POOL` 与 `MAX_BATCH` 守。

**D4:治理——限频按请求,用量按落地条数。**
- **鉴权**:同 `/ingest`(`governanceMiddleware` 的 `authenticate`)。
- **限频**:`checkRateLimit` 每请求 +1 token——批量 = 1 请求 = 1 token。payload 受 `MAX_BATCH` 上限约束,单请求不致放大 KV/工作量;无需按条限频(按条限频会让一次合法大批量误触发限频)。
- **用量:准入恒计 1 为基线,落地条数为叠加增量**(与既有「放行(admission)计数」**自洽**,非替换——CR 点名)。语义锚死:每个受保护请求**准入恒计 1**(覆盖 `/parse`/`/contribute`/`/ingest` 单条、以及批量的 `persistence-error`/`accepted=0` 等所有放行/失败放行场景,与既有 api-governance「放行计数」基线一致);批量在此基线**之上**,`accepted≥2` 时**额外**叠加 `accepted-1`,使该请求总用量 = `accepted`(N 条落地 = N,与单条上报 N 次一致)。`accepted=0`/`accepted=1` 不叠加、用量 = 准入的 1。
  - 机制:`recordUsage(env, key, amount = 1)` 加可选 `amount`(默认 1,**向后兼容**——既有唯一调用点 `governance.ts` 中间件不传 amount → +1,`/parse`/`/contribute`/`/ingest` 用量不变);`governanceMiddleware` 在 `authenticate` 通过后 `c.set('govKey', auth.key)` 暴露 key,仍 `recordUsage(env, key)` 计 1(准入基线);批量 handler 落地 `accepted` 条后 `if (accepted > 1) recordUsage(env, key, accepted - 1)`(**guard `>1`**:`accepted=0`/`1` 不叠加、绝不传 `amount≤0`,防 KV `count` 被减损坏)。注:`accepted=0` 经 D5 走 500 路径(handler 在返 500 前不叠加),用量 = 准入 1,与既有「persistence-error 放行也计数」一致。
  - **类型基建(CR 点名,必须同改一串泛型,否则 build 红)**:`c.set/get('govKey')` 需 Hono `Variables` 泛型,当前全仓只 `{ Bindings }`。在 **`bindings.ts`**(`routes.ts` 与 `governance.ts` **都已** `import type { Bindings }` 的共享叶子)定义 `type AppEnv = { Bindings: Bindings; Variables: { govKey: string } }`——**放 `bindings.ts` 而非 `routes.ts`**(CR round-2:放 `routes.ts` 会迫使 `governance.ts` 反向 import `routes.ts`、反转既有 `routes → governance` 依赖方向;放共享叶子则两边都从 `bindings.ts` 取、方向不变、`Variables` SOT 与 `Bindings` SOT 同处)。把 `createApp` 的 `Hono<…>`、全部 `Context<…>`(`parseContributeBody`/`resolveRepo`/`landRaw`/`AppDeps.scheduleBackground` 的 Context 参数)、`governance.ts` 的 `MiddlewareHandler<…>` **统一**切到 `AppEnv`。**禁止** `as string` 容错(绕过类型保护、违 schema/types SOT 精神)。
  - **并发计数近似**(CR minor):批量补计是同 key 的**第二次**非原子 KV read-modify-write(中间件准入一次 + handler 叠加一次),放大既有非原子计数的丢失窗口;用量为 metadata-only、`recordUsage` **不抛**(失败仅 warn、不改响应),容忍此近似(与 rate-limit 非原子同理念)。
  - 备选(否决):用量也按请求 +1。否决——50 条算 1,批量成用量盲区,违反「避免批量绕过用量统计」。

**D5:错误码集合同 `/ingest`;`accepted=0` 走 500(修正 Codex「全失败伪装成功」)。**
`/ingest/batch` 请求路径错误码 = `{ invalid-request(400), persistence-error(500), internal(500), accepted(202) }` + 治理码,**不含** `insufficient-information`/`config-error`(解析在后台、不影响 HTTP 状态)。
- `invalid-request(400)`:非 JSON / 非 `{items}` / 空 / 超 `MAX_BATCH` / 任一条目不合 schema。无任何 raw 落地。
- `persistence-error(500)`:repo 未绑定 / `resolveRepo` 抛错(整批,无 raw 落地)**或**信封合法、repo 解析成功但**全部条目 `upsertRaw` 失败**(`accepted=0`)。理由:`accepted=0` = 服务端**未落任何 raw**,返 2xx 会把整批写失败伪装成已受理、调用方无法区分(与单条 `/ingest` 的 `upsertRaw` 失败→500 一致)。
- `202`:信封合法 + repo 解析成功 + **`accepted ≥ 1`**(至少落 1 条 raw)。**部分失败**(`accepted≥1` 且 `failed.length≥1`)仍 202,逐条失败由 body 的 `failed: [{index,store,storeSku}]` 报告(客户端据 `index` 精确重试失败条);整批不回滚已落地条目。
- `internal(500)`:`BatchIngestResponseSchema` 自身校验失败的防御兜底(实质不可达)。
- raw 落地判据:`202` ⟺ `accepted≥1`(至少落了若干 raw);`accepted=0` 一律 500、不返结果体。无单一 `rawId` 字段(批量,各条独立)。

## 风险 / 权衡

- **[R1 Worker 子请求上限 → `MAX_BATCH=40` 默认保守(修正 Codex「100 与免费计划矛盾」)]** 单次 invocation 的后台 LLM fetch 总数 = `landed` 中触达 tier2 的条数 ≤ `MAX_BATCH`,计入该 invocation 的子请求预算(免费 50 / 付费 1000)。**默认取 `MAX_BATCH=40`**(免费计划 50 上限内、留余量给非 LLM fetch),使本端点在**未确认付费计划时也能安全上线**、不把运行时超限风险 defer 到部署。**调高到 100+ 须先确认生产 Worker 为付费计划(1000 子请求)**,这是显式部署前置、不是 tasks 里的「跑前再说」。`BG_POOL=5`(D3)另限**并发**(LLM 速率/成本、D1 并发),与子请求**总量**(`MAX_BATCH`)是两个独立约束。CPU:后台经 `BG_POOL` 串行化、单 invocation 总 CPU 有上限——逼近时尾部条目 `saveParsed` 可能未完成(留「有 raw 无 product」中间态,可后续重解析,与 `/ingest` 同理念、可接受)。
- **[R2 用量叠加的边界]** 准入恒计 1 + `accepted≥2` 叠加 `accepted-1` = `accepted`;`accepted=1`→不叠加(用量 1);`accepted=0`→经 D5 走 500、不叠加(用量 = 准入 1,与既有「persistence-error 放行也计数」一致)。**guard `accepted>1`** 确保绝不传 `amount≤0`(防 KV count 减损坏)。须测:accepted=N→用量 N;N=1→1;N=0(500 路径)→1。
- **[R3 部分落地的幂等与重试]** 插件据 `failed` 的 `index` 出队:`failed` 列出的下标留、其余(landed)删。failed 条目下次随新批重发,`upsertRaw` 幂等(同 `(store,storeSku)` 收敛同行),不堆叠;已 land 但后台 `saveParsed` 失败的(202 里算 accepted)留「有 raw 无 product」——插件已出队不再重发,该 raw 由后续批量重解析补齐(非目标,已知可接受)。
- **[R4 与 `/ingest` 注册序/路径遮蔽]** Hono 精确匹配,`/ingest` 与 `/ingest/batch` 不同路径互不遮蔽;但 `app.use('/ingest', ...)` 是否会作为前缀中间件套住 `/ingest/batch`?Hono `app.use('/ingest', mw)` **精确匹配** `/ingest`(非前缀通配),不会套住 `/ingest/batch`;故 `/ingest/batch` 需**自己**挂 `governanceMiddleware`。tasks 须测 `/ingest/batch` 无 key → 治理 401(确认治理确实生效、未漏挂)。
- **[R5 响应体大小]** `failed` 最多 `MAX_BATCH` 个 `{index,store,storeSku}`;`MAX_BATCH`(默认 40)个小对象 ≈ 数 KB,无虞。
