## 为什么

榜单里「历史上便宜、但很久没人再报价」的商品当前与新鲜数据无差别呈现,用户无从判断这条单价是不是陈旧。同时,一件商品从低点涨价后,榜单只显示最新整件价,用户看不到它曾经的历史低点(错过抄底的信号)。这两点都是**读侧标注**,数据基本已就位(`product_raw` 每次重报覆写 `price`/`captured_at`),只差把信号透出到榜单行。

## 变更内容

- **失效置灰(>30 天未重报)**:榜单响应透出 `capturedAt`(epoch ms);前端以 `now - capturedAt > 30 天` 将该行置灰。**失效商品不下架、仍留榜**(它们正是「历史上便宜」的参考项),不改榜单 WHERE / 排序。阈值 `STALE_AFTER_MS` 作**小程序侧命名常量**(展示策略、服务端不消费;小程序对 `@unit-price/core` 无依赖边且经 babel 引 Zod 会崩,故不放 core)。失效判定**放客户端**而非服务端返回布尔——`/rankings` 经 CDN/SWR 缓存,服务端烤进响应体的时间相对布尔会在缓存里衰减,`capturedAt` 是不可变事实、缓存安全。
- **历史最低价标注**:`product_raw` 新增列 `lowest_price`(整数分),`upsertRaw` 每次重报**仅对正价**维护 `min(既有水位, 新价)`(异常 0/负价不折进,避免永久毒化水位显示「历史低 ¥0.00」;首插取正价、否则 NULL);榜单响应透出 `lowestPriceCents`(= `COALESCE(lowest_price, price)`);前端仅当 `priceCents > lowestPriceCents` 时呈现「历史低 ¥X.XX」。
- 榜单响应契约 `RankingsItem` 新增两字段 `capturedAt` / `lowestPriceCents`,设 **`.optional()`**。`RankingsItem` 仅从库内 `RankingRow` 投影(`/rankings` 与 `/compute` 邻居行都走它,后者经 `ComputeResultSchema` 按引用复用同一 schema);服务端稳态恒发二字段、功能完整,`.optional()` 只为容忍跨版本(旧服务端/新小程序)与 CDN 24h 缓存旧响应——否则新小程序解旧响应会 ZodError 整屏错。

## 功能 (Capabilities)

### 新增功能

（无——均为对既有能力的扩展。）

### 修改功能

- `persistence`:`product_raw` 新增 `lowest_price` 列并在 upsert 维护历史最低价水位(新增一条需求,与既有 `native_category_id` 需求同范式);迁移加列 + 一次性回填存量行 `lowest_price = price`。
- `rankings-api`:`GET /rankings` 响应契约 `RankingsItem` 增加 `capturedAt` / `lowestPriceCents` 两个投影字段,并放宽此前「本变更不改该 schema」的措辞。
- `api-client`:`RankingsItem` 字段集枚举同步增加两字段(契约单一事实源)。
- `miniapp`:榜单行按失效置灰、并在现价高于历史低价时标注历史低价(新增一条渲染需求)。

## 影响

- **代码**:`packages/db`(schema 加列 + Drizzle 迁移 `0007_*` + `upsertRaw` 仅正价维护 min + `RawRankingRow`/`RankingRow` 投影加两列)、`packages/api-client`(`RankingsItemSchema` 加两 `.optional()` 字段)、`apps/api`(`/rankings` 与 `projectNeighbor` 透传两字段)、`apps/miniapp`(`RankingRow` 组件置灰 + 历史低价徽标 + `STALE_AFTER_MS` 本地常量)。
- **数据/迁移**:一条 DDL 迁移(加可空列 + 幂等回填 `UPDATE product_raw SET lowest_price = price WHERE price > 0 AND lowest_price IS NULL`)。生产 push-to-main 自动 migrate(先 migrate 后 deploy),加列对非空表安全。
- **合规**:不触碰抓取/众包敏感面,只在既有众包数据上做读侧标注。
- **缓存/契约兼容**:透出字段为不可变事实(`capturedAt`)或随重报刷新(`lowest_price`/`price`),不引入随时间衰减的响应体值;字段设 `.optional()` 使 CDN 24h 旧缓存与跨版本客户端均可解析、无需 CDN purge。

## 非目标

- **不修** `unit_price.per100ml` first-write-wins 冻结在首报的既有 quirk——榜单仍按冻结 per100ml 排序、显示最新整件价,本次两功能不动它。
- **不做**存量/窗口历史价格追溯:现有 ~300+ 行无历史流水,`lowest_price` 只能初始化为当前价;迁移先于部署的短窗口内旧 worker 更新 `price` 也可能漏一个新低(尽力而为、下次再报即自愈)。往后正价 upsert 起才是真实 min。
- **不做** ingest 侧 `capturedAt` 合理性校验(量级/未来偏移/单调)——属既有 ingest 契约收紧、跨越本变更;本期靠「省略则服务端 `Date.now()` ms」+ 运营侧约定兜底,记为后续跟进。
- **不做**服务端定时任务/物化失效标记列(纯派生,读时算即可)。
- **不做**榜单顶部「全局新鲜度横幅 / 更新于 X月X日」(仍属 P8,与本次的**逐行**置灰不同)。
- **不改**榜单入榜门/排序/分页/cohort 守卫口径。
