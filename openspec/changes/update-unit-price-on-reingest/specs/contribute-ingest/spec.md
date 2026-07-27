## 修改需求

### 需求:观测优先的两段落地

`/contribute` **必须**先 `upsertRaw` 落地原始观察,**再**跑 `orchestrate` 解析,最后在解析成功时 `saveParsed` 落 `product` + `unit_price`。原始上报是最珍贵的众包资产:即便 `orchestrate` 因 LLM 故障返回非 `ok`,**已落地的 `product_raw` 行必须保留**(供日后重解析),不得回滚。`saveParsed` **仅当** `orchestrate` 返回 `ok` 时执行;此时传给 `saveParsed` 的 `calc` 由 `orchestrate` 响应直接组装(`{ unitPrice, confidence, warnings }`),`spec` 用同一响应的 `spec`,**禁止**在 API 层重算 `per100ml`。

由于 raw 先落地,`orchestrate` 失败(`insufficient`/`config-error`,raw 已落但 parse 未落)的**错误响应体必须附 `rawId`**——告知客户端原始观察已沉淀、重试仅为补解析,而非重新上报。客户端重试**安全**(同 `(store, store_sku)` 经 upsert 幂等收敛到同一 raw 行、不堆叠),但**会重新触发 tier2 LLM**(`/contribute` 无内容级解析缓存),其滥用成本由 `api-governance` 限频兜底。`saveParsed` 抛错留下的「有 raw 无 product」中间态是**有意接受**的(`getProduct` 只查有 product 的行,不受影响),供后续批量重解析补齐。

去重落地沿用 persistence 既有语义:同 `(store, store_sku)` 再次上报为 upsert——`price`/`title`/`captured_at` **无条件覆盖**为最近一次;而 `source`/`sourceUrl`(溯源增列)与 `categoryHint`(领域可空字段,沿用 repository 既有处理、与 `title` 的无条件覆盖策略不同)三者按 **COALESCE** 语义:重报提供新非空值则更新、**重报省略(null)则保留旧值**(不被 null 覆盖、不清空)。不堆叠重复行。

**重报的价格必须一路推进到派生层。** 同款重报走到 `saveParsed` 时,若解析结果与首报等价(同 `dedupe_key`),`product` 行按 persistence 语义保留最老一条,而其 `unit_price` 五列**必须**刷新为**本次** `orchestrate` 产出的 `calc`(刷新语义、无条件写与失败处置归 persistence「product 必须按去重键收敛」需求)。API 层**禁止**为此另算单价。

**因此,「`product_raw.price` 已是新价、`unit_price` 仍是旧价」在 `saveParsed` 成功执行且命中去重时禁止出现**——榜单大字单价与排序读的正是 `unit_price`。该禁令是**条件式的**:本能力的其它既有规则会合法地产生同一外观的中间态,**必须**逐一承认而非假装不存在:

- **解析未完成或失败**:`orchestrate` 非 `ok` 时 raw 已落新价而 `saveParsed` **不执行**(本需求上文明令保留 raw)。
- **刷新写失败**:去重命中现在含一条写,它可能失败(`/contribute` → `500` 且附 `rawId`;`/ingest` 后台 → 只记日志、不重试)。
- **落地顺序与解析完成顺序可逆**:`/ingest` 是 `202` + 后台解析,同一 SKU 两次上报的 `upsertRaw` 顺序与其 `saveParsed` 完成顺序无耦合,迟到的解析会让派生值落后于 `product_raw.price`。
- **解析结果漂移**:标题变动或 tier2 抖动使本次 `spec` 与首报不等价 → 新 `dedupe_key` → 落**新** `product` 行,**旧行不被任何 `saveParsed` 命中**、其派生值停在旧价(属已知非目标的多 product 行 quirk)。

**前三类的收敛动作是「再重报一次该商品」**,且该重报**必须经同步路径**(`/contribute`:`upsertRaw → orchestrate → saveParsed` 全在请求内完成)——经 `/ingest` 重报会再引入一个在飞的后台单元,可能被更早的迟到写覆盖。**第四类(解析结果漂移)没有收敛动作**:旧 `product` 行的 `dedupe_key` 永不再被命中,再重报只写新行,它是**已披露的不可修残留**、只在普查中登记。**禁止**声称任何一类会自动实时收敛。本能力**禁止**声称同步或自动的自愈;运维侧的检出手段见 `docs/backfill-runbook.md`。

`/contribute` 的**成功响应**过 `ParseResponse` + 三 id 的 Zod 校验;**错误响应**沿用既有 `/parse` 形态(`{ error, message }`,不另设 Zod schema)。rawId 归属判据是 **raw 是否已落地**:raw 已落地后才发生的**业务错误**(`insufficient`/`config-error`,以及 `saveParsed` 失败的 `persistence-error`)在该形态上**附单字段 `rawId`**(即 `{ error, message, rawId }`);raw 未落地的错误(`invalid-request`、DB 不可用/`upsertRaw` 失败的 `persistence-error`)**不含 `rawId`**(无可附之 id)。**一个刻意例外**:`internal`(响应自身校验失败的防御性兜底)虽在 raw 已落地后才可能触发,但它在 `ok` 结果下**实质不可达**(`spec`/`unitPrice` 已由 orchestrate 产出且过 `ParsedSpecSchema`、三 id 均非空),沿用 `/parse` 既有 `{ error, message }` 形态、**不附 `rawId`**——作为例外单列,不纳入上面的「raw 已落 ⇒ 附 rawId」判据。

#### 场景:解析失败时 raw 仍保留且响应附 rawId
- **当** `orchestrate` 返回 `insufficient` 或 `config-error`(如 LLM 不可用)
- **那么** `product_raw` 中本次上报的行**必须**已落地并保留(**禁止**因解析失败而删除或回滚 raw),且错误响应体**必须**含该行的 `rawId`

#### 场景:同款重复上报收敛为一行
- **当** 同一 `(store, store_sku)` 被 `/contribute` 上报两次(价格不同)
- **那么** `product_raw` 只保留一行,`price`/`title`/`captured_at` 更新为最近一次(去重键确定、与价格无关);`product` 仍只有一条(最老),而其 `unit_price` 的 `per100ml`/`formula` **必须**为**第二次**价格算出的值

#### 场景:重报省略溯源字段时保留旧值
- **当** 同一 `(store, store_sku)` 第二次上报省略了 `sourceUrl`(传 null/缺失),首次曾带 `sourceUrl`
- **那么** 该行 `source_url` 列**必须**保留首次的值(COALESCE 语义,**禁止**被 null 覆盖清空)

#### 场景:同步响应不是库内状态的读回

- **当** 一次 `/contribute` 成功返回 `200` 后,其写入被另一次更晚完成的解析覆写(刷新**失败**的调用没有成功响应体、只返回 `500 persistence-error` + `rawId`,不在本场景内)
- **那么** 该端点**成功**响应体里的 `unitPrice` 仍取自本次编排的内存结果、**可能与库内值不同**;调用方**禁止**把响应体当作库内状态的读回

### 需求:后台解析失败只记日志且不重试

后台 `orchestrate` 按三态分流,**禁止**反复重试或反复消耗 LLM:

- `ok` → `saveParsed` 落 `product` + `unit_price`(`calc` 由 `orchestrate` 响应直接组装 `{ unitPrice, confidence, warnings }`,**禁止**在 API 层重算 `per100ml`;不可计算 `per100ml=null` 照常落库)。
- `insufficient`(tier2 传输失败且 tier1 无 shape,如「饮用天然水」无规格标题)→ **只**打结构化日志(含 `rawId`/`store`/`storeSku`),**不** `saveParsed`、**不**自动重试、**不**重发 LLM。
- `config-error`(运行期配置错误)→ 只打日志,**不**重试。
- `saveParsed` 抛错 → 只打日志,**不**重试。**该分流现有两种形态**:首插抛错留下「有 raw 无 product」;**去重命中的刷新抛错**留下「product/unit_price 已存在、但派生值仍是旧值」——后者**禁止**被描述成「product 不落」。

后台失败留下的「有 raw 无 product」中间态是**有意接受**的(与本能力既有中间态同质,`getProduct` 只查有 product 的行,不受影响)。客户端重试**安全**且不堆叠(同 `(store, store_sku)` 经 `upsertRaw` 幂等收敛同一行;每次上报仍只触发一次后台解析,总量由 `api-governance` 限频在入口兜住)。本期**不**做后台瞬态失败的有界重试(留作后续 Queues/cron 独立变更)。

#### 场景:不可解析标题只解析一次
- **当** 一条标题无规格(`orchestrate` 后台返回 `insufficient`)的上报经 `/ingest` 处理
- **那么** 服务**必须**只跑一次后台 tier2、打日志、保留 `product_raw` 行,**禁止**把它再次喂给 LLM(无重扫/重试机制)

#### 场景:后台 config-error 不影响已返回的 202
- **当** 后台 `orchestrate` 返回 `config-error`(运行期配置错误)
- **那么** 客户端**已**收到的 `202`/`rawId` **不**受影响(失败只进日志、不 `saveParsed`、不重试),`product_raw` 行保留、`product` 不落

#### 场景:后台 saveParsed 抛错保留 raw 且不影响 202
- **当** 后台 `orchestrate` 返回 `ok` 但 `saveParsed` 在**首插**(未命中既有 `dedupe_key`)时抛错
- **那么** 客户端**已**收到的 `202`/`rawId` **不**受影响(失败只进日志、不重试),`product_raw` 行**保留**、`product`/`unit_price` **不落**(「有 raw 无 product」中间态),后台**禁止**重发 LLM 或重扫。**命中去重时的刷新抛错是另一形态**,见下一场景

#### 场景:去重命中的刷新抛错留下的是派生值落后

- **当** 后台 `orchestrate` 返回 `ok`、`saveParsed` 命中既有 `dedupe_key`,但刷新写抛错
- **那么** 客户端**已**收到的 `202` **不**受影响;`product`/`unit_price` **仍存在**(它们本就在)、其派生值**仍是旧值**;该态由下一次重报收敛,后台**禁止**重试
