## 新增需求

### 需求:product_raw 必须维护历史最低价水位(lowest_price)

`product_raw` **必须**新增可空列 `lowest_price`(可移植 `INTEGER`,整数分,语义同 `price`),记录该 `(store, store_sku)` 商品**历次正价观测到的最低整件价**。它是溯源/派生增列、**不在** `RawProductSchema` 内,与领域列正交。它是 `product_raw` 首个**跨观测运行聚合**列(既有列都是当次/首次观测的时点属性),故 `productRaw` docstring 须点明这一新语义。

- **仅正价入水位(硬约束)**:`RawProductSchema` **放行 ≤0/负价**(`product_raw` 忠实存含异常价的原始观察,由 core 路由到 per100ml=null)。若把 0/负价折进 `min`,水位会被**永久毒化**(`min` 单调只降),叠加 `unit_price` first-write-wins 使已入榜项恢复价后显示「历史低 ¥0.00」或负值。故水位维护与回填**必须只纳入 `price > 0` 的观测**,`price <= 0` 的观测**禁止**改动或初始化水位。
- **列必须可空**;经标准 `drizzle-kit generate` DDL 迁移加列(登记 `_journal.json`,**区别于** 0004/0005 的目录扫描幂等 DML 种子迁移)。prod `product_raw` 非空表加**可空 `INTEGER`** 列对 SQLite 安全(无需 DEFAULT)。同一迁移文件尾部**必须**一次性回填存量行 `UPDATE product_raw SET lowest_price = price WHERE price > 0 AND lowest_price IS NULL`——存量无历史价格流水,只能以当前正价初始化(不可追溯真实历史低点);`WHERE ... IS NULL` 使回填**自幂等**(即便 journal 被手工改动误重放也是 no-op、不把已累积真实低点重置回当前价),`price > 0` 排除异常价存量。
- **`upsertRaw` 必须维护水位**:首次插入写 `lowest_price = (price > 0 ? price : NULL)`;对 `(store, storeSku)` 冲突时,新价为正才折进——`lowest_price = CASE WHEN 新价 > 0 THEN min(coalesce(lowest_price, 新价), 新价) ELSE lowest_price END`(既有水位与新正价取小者,`coalesce` 兜住无水位时以新价起算;新价 ≤0 则保留旧水位不动)。`title`/`price`/`captured_at` 仍随最新观测覆写(不受本列影响);水位对正价**只降不升**。
- **禁止**用价格历史明细表实现:本列只承载「历史最低价」这一标量,不保留逐次流水。
- 榜单读投影(`listRankings` 及其 `RawRankingRow`/`RankingRow`)**必须**投出 `lowest_price` 供 `rankings-api` 透出为 `lowestPriceCents`,并以 `COALESCE(lowest_price, price)` 取值,使投影结果**恒为整数**(存量偶有 `NULL` 或仅异常价历史时退化为当前价)。因客户端仅当 `priceCents > lowestPriceCents` 才呈现「历史低」,退化为当前价时(相等)不呈现、异常价也不会被当作历史低呈现。该投影仍**只读、不重算**(与既有 per100ml/formula 取存储值同口径)。

#### 场景:首次正价上报把水位置为当前价
- **当** 某 `(store, store_sku)` 商品首次经 `upsertRaw` 落库、`price = 1290`
- **那么** `product_raw.lowest_price` **必须** = `1290`

#### 场景:价格回落刷新更低水位
- **当** 同款先以 `price = 1290` 落库(`lowest_price = 1290`),后重报 `price = 990`
- **那么** `product_raw.price` 更新为 `990`、`lowest_price` **必须**刷新为 `990`(取 `min`)

#### 场景:价格上涨保留历史低点
- **当** 同款先以 `price = 990` 落库(`lowest_price = 990`),后重报 `price = 1490`
- **那么** `product_raw.price` 更新为 `1490`、`lowest_price` **必须**保留 `990`(`min(990, 1490)`,水位只降不升)

#### 场景:异常 0/负价不毒化水位
- **当** 同款先以 `price = 990` 落库(`lowest_price = 990`),后重报异常 `price = 0`(或负价)
- **那么** `product_raw.price` 忠实更新为 `0`、但 `lowest_price` **必须**保留 `990`(≤0 观测不折进水位);若某款**仅**有过 ≤0 观测,则其 `lowest_price` **必须**为 `NULL`(读投影退化为当前价、不呈现历史低)

#### 场景:加列迁移对非空 prod 表安全并仅回填正价存量为当前价
- **当** 生产经自动 migrate 应用该加列迁移
- **那么** `product_raw.lowest_price` **必须**以可空 `INTEGER` 落地、不破坏既有数据,且同迁移的回填**必须**把每条 `price > 0` 存量行的 `lowest_price` 置为其 `price`、`price <= 0` 的存量行保持 `NULL`(回填带 `WHERE price > 0 AND lowest_price IS NULL`、幂等)

#### 场景:读投影经 COALESCE 恒为整数
- **当** 榜单读投影读取某行(其 `lowest_price` 因无正价历史/回填前边角态为 `NULL`)
- **那么** 投出的历史最低价 **必须** = `COALESCE(lowest_price, price)`(退化为当前价),**禁止**透出 `NULL`;正常有正价水位的行直接取 `lowest_price`
