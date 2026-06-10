## 新增需求

### 需求:POST /ingest 异步采集端点

`apps/api` **必须**提供 `POST /ingest`,用于「只管快速上报、不需要实时解析结果」的众包采集(如 Surge 插件)。它**同步**落 `product_raw` 后**立即**返回,把 tier2 解析与单价计算移出请求路径(见「后台异步解析」需求)。`/contribute`(同步返回完整解析结果)**保持不变**,两端点**并存**、服务两类客户端。

请求体**必须**复用 `/contribute` 既有的 `ContributeRequestSchema`(同一份 Zod SOT,**不**新增重复 schema):领域 `title`/`price`(`finite`,负价/0 价合法)/`categoryHint?`,溯源 `store`/`storeSku`(均 `trim().min(1)`)/`source?`/`sourceUrl?`/`capturedAt?`(int epoch ms)。**单条**上报(本期**不**做批量 `/ingest/batch`)。

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

### 需求:后台异步解析必须经可注入端口执行

`/ingest` 的 `orchestrate`(tier1+tier2+tier3)+ `saveParsed` **必须**在响应返回后于**后台**异步执行,且**必须**经一个**可注入的「后台执行端口」**调度(与 `makeLlm`/`makeRepo`/`governance` 同范式),路由**禁止**直接裸调 `c.executionCtx`。后台工作单元 `run` **必须**为 `async` 函数且**自包 try/catch**——使其同步与异步异常都被收敛在后台(包成 rejected promise 交 `waitUntil`),**禁止**任何后台异常传播回**已决定的 `202` 响应路径**(否则 `run` 的同步抛错会污染本应秒返的 202)。

- **生产**(Cloudflare Workers)注入的实现**必须**用 `c.executionCtx.waitUntil(run())`,使后台解析在响应发出后于同一次调用内继续(事件驱动、每条上报**只触发一次**后台解析,**禁止**轮询/重扫导致反复触发 LLM)。
- **Node dev** 无执行上下文(`c.executionCtx` getter 会 throw),注入的实现(或缺省)**必须**为**同步** `await run()`,使本地/测试行为**确定**(`202` 在后台解析完成后返回);路由对生产/dev **统一** `await scheduleBackground(c, run)` 后再返回 `202`,不感知运行时差异。

#### 场景:生产后台落库
- **当** 生产环境注入 `waitUntil` 版后台端口,一条 `ok` 可解析的上报到达 `/ingest`
- **那么** 服务**必须**先 `202` 返回,再于后台 `saveParsed` 落 `product` + `unit_price`(响应不等待解析完成)

#### 场景:dev/测试同步可断言
- **当** 测试注入同步版后台端口,POST 一条 `ok` 上报
- **那么** 后台解析**必须**在 `202` 返回前同步跑完,使测试可断言 `product`/`unit_price` 已落库

#### 场景:路由不裸调 executionCtx
- **当** 检查 `/ingest` 路由实现
- **那么** 它**禁止**直接引用 `c.executionCtx`(避免 Node dev getter 抛错),后台调度**必须**经注入端口

### 需求:后台解析失败只记日志且不重试

后台 `orchestrate` 按三态分流,**禁止**反复重试或反复消耗 LLM:

- `ok` → `saveParsed` 落 `product` + `unit_price`(`calc` 由 `orchestrate` 响应直接组装 `{ unitPrice, confidence, warnings }`,**禁止**在 API 层重算 `per100ml`;不可计算 `per100ml=null` 照常落库)。
- `insufficient`(tier2 传输失败且 tier1 无 shape,如「饮用天然水」无规格标题)→ **只**打结构化日志(含 `rawId`/`store`/`storeSku`),**不** `saveParsed`、**不**自动重试、**不**重发 LLM。
- `config-error`(运行期配置错误)→ 只打日志,**不**重试。
- `saveParsed` 抛错 → 只打日志,**不**重试。

后台失败留下的「有 raw 无 product」中间态是**有意接受**的(与本能力既有中间态同质,`getProduct` 只查有 product 的行,不受影响)。客户端重试**安全**且不堆叠(同 `(store, store_sku)` 经 `upsertRaw` 幂等收敛同一行;每次上报仍只触发一次后台解析,总量由 `api-governance` 限频在入口兜住)。本期**不**做后台瞬态失败的有界重试(留作后续 Queues/cron 独立变更)。

#### 场景:不可解析标题只解析一次
- **当** 一条标题无规格(`orchestrate` 后台返回 `insufficient`)的上报经 `/ingest` 处理
- **那么** 服务**必须**只跑一次后台 tier2、打日志、保留 `product_raw` 行,**禁止**把它再次喂给 LLM(无重扫/重试机制)

#### 场景:后台 config-error 不影响已返回的 202
- **当** 后台 `orchestrate` 返回 `config-error`(运行期配置错误)
- **那么** 客户端**已**收到的 `202`/`rawId` **不**受影响(失败只进日志、不 `saveParsed`、不重试),`product_raw` 行保留、`product` 不落

#### 场景:后台 saveParsed 抛错保留 raw 且不影响 202
- **当** 后台 `orchestrate` 返回 `ok` 但 `saveParsed` 写入时抛错
- **那么** 客户端**已**收到的 `202`/`rawId` **不**受影响(失败只进日志、不重试),`product_raw` 行**保留**、`product`/`unit_price` **不落**(「有 raw 无 product」中间态),后台**禁止**重发 LLM 或重扫

### 需求:/contribute 同步契约不受 /ingest 影响

引入 `/ingest` **禁止**改动 `/contribute` 的既有同步契约——`/contribute` 仍**必须**同步 `upsertRaw → orchestrate → saveParsed` 并返回含 `spec`/`unitPrice`/`confidence`/`warnings`/`rawId`/`productId`/`unitPriceId` 的 `200`(或既有 `400`/`500`/`503` 错误语义),其 spec 既有场景与响应体**保持不变**。

#### 场景:/contribute 行为不变
- **当** 客户端 POST 一条有效商品到 `/contribute`
- **那么** 服务**必须**按既有语义同步返回 `200` + 完整解析结果 + 三 id(与本变更前完全一致)
