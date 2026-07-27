## 修改需求

### 需求:product 必须按去重键收敛、相同结果只保留最老一条

`saveParsed` 落库 `product` 时**必须**对「同一来源 + 相同解析结果」去重:**禁止**为等价的重复输入堆叠多条 `product` 行(否则同一款被未来榜单重复计数/排序、污染真实单价榜)。

**去重键必须为 `(rawId + 规范化 ParsedSpec)`、与价格无关。** 键字段为 `rawId`、`unit_size_value`、`unit_size_unit`、`quantity`、`total_amount_value`、`total_amount_unit`、`category`、`multipliers`、`package_unit`;**禁止**纳入 `per100ml`/`formula`(价格派生值),且键**禁止**涉及 `unit_price` 表任何列(含其 `confidence`/`warnings`)——价格变动属同款更新、不应制造新「结果」行(与 `product_raw` 去重键「与价格无关」同口径)。`ParsedSpec.confidence`(`product.confidence` 列)**亦排除**:它是解析中间置信、非「结果结构」一部分,同 rawId 同 spec 结构、不同 confidence(如 tier2 复算)**必须**判为同款重复、保留最老(不因置信抖动堆叠新行)。键**必须**由确定性纯函数构造(IO 层 / `packages/db` 的独立模块,**禁止**污染 `core`、**禁止**塞入 `codec`):相同 `ParsedSpec` 结果**必须**得相同键、不同结果**必须**得不同键;`null` 与 `undefined` 可空字段**必须**归一为 JSON `null`(**禁止**用字符串哨兵——会与真值字符串碰撞误去重;JSON 规范区分 `null`/数字/字符串);measurement/JSON 序列化**必须直接调用**落库所用的 `encodeMeasurement`/`encodeJson`(**禁止**另写等价序列化,以免漂移);最终键**必须**以结构化数组整体序列化产出(**禁止**裸字符串拼接,以免 `"a|b"` 分隔歧义)。

**保留最老一条必须由数据库唯一约束保证。** `product` 表**必须**新增 `dedupe_key`(`TEXT NOT NULL`)列与其 **`uniqueIndex`**——**首个成功插入的行赢、后到等价行被拒/no-op**,「保留最老」由唯一约束天然保证,**禁止**依赖应用层 rowid 比较或读后写时序。`dedupe_key` 是溯源/收敛增列(类同 `raw_id`),**非**领域字段、不进 `ParsedSpec`。

**「保留最老」只约束 `product` 行的身份,不冻结 `unit_price` 的派生值。** 去重键与价格无关是**有意**的(调价属同款更新、不该堆行),但同一款的价格会随重报变动,而 `per100ml`/`formula` 是价格的确定性派生:命中去重时若不更新它们,榜单会长期按**首次观测价**排序与展示,与同一行显示的最新整件价自相矛盾。故对 `unit_price` 而言,「最老」**仅**指其**行与 id**、**不**指派生值;而 `product` 行(含其 `confidence` 解析置信)**保持全列冻结**——刷新一列都不碰它。由此 `getProduct` 返回值里 `spec.confidence`(首次解析)与 `unitPrice.confidence`(最新)可以不同源,这是有意为之;榜单读的是后者。

**双驱动写路径必须各自保证首插原子 + 不留孤儿(机制不同但等效)。**
- **sqlite 驱动**(单连接、无真并发):`saveParsed` **必须**在单个 `transaction` 内 `insert(product)` 用 `onConflictDoNothing(target dedupe_key)` 并判 `changes`/`returning`——真插入(`changes=1`)→同事务内插 `unit_price`、返回新对;命中既有(`changes=0`)→`SELECT` 既有 `product`+`unit_price`、**在同一事务内用本次 `calc` 刷新既有 `unit_price`**、返回既有对、**不**插新 unit_price。两插同事务,首插原子。
- **D1 驱动**(有真并发):`saveParsed` **必须** SELECT-first(`SELECT product by dedupe_key`)——命中→**刷新既有 `unit_price`** 后返回既有对、**不**插新行;未命中→`batch([insert product, insert unit_price])` 原子写,其中 product **必须用裸 `insert`、禁止 `onConflictDoNothing`**。**禁止**对 D1 path 的 product insert 用 `onConflictDoNothing`:它会吞掉唯一冲突使 `batch` 不抛错、`unit_price` 照插成孤儿。并发抢插时裸 insert 命中唯一索引**抛错** → `batch` 全成全败、整体回滚 → `saveParsed` **必须**捕获该错并回退到「SELECT 既有 → 刷新 → 返回」分支(此时先提交方已落库、必查到)。首插原子由 `batch` 保证。

**去重命中时必须刷新既有 `unit_price`、禁止留孤儿、必须返回既有最老行;回退查空即数据损坏必须抛错。** 命中既有 `dedupe_key` 时,`saveParsed` **必须不**插入新 `unit_price` 行,而**必须**查既有 `product` 及其 `unit_price`,**用本次调用的 `calc` 覆写该行的 `per100ml`、`per100g`、`formula`、`confidence`、`warnings` 五列**,并返回**既有(最老)** 的 `{productId, unitPriceId}`。

刷新是**无条件写**:**禁止**加「与 `product_raw.price` 比较后跳过」之类的条件谓词。`product_raw.price` 是 `Math.round(元价×100)` 的结果,**不能识别一次观测**(两个相差不足一分的元价折算成同一个分值;价格回摆 `A→B→A` 是促销常态),而且**首插路径**根本不在这类谓词覆盖内;更要紧的是「跳过」假定有更新的写者会写对,而 `/ingest` 的后台解析**失败时只记日志、不重试**,那个写者可能根本不存在——跳过的行就此无人收拾。无条件写让**最后完成的解析结果**落地。

写入值**必须**取自入参 `calc`(已过 `CalcResultGate`,`warnings` 即 `orchestrate` 汇总的并集),**禁止**在本层重算单价、**禁止**在刷新中改写 `product` 行或 `product_raw` 任何列。其中 `SELECT unit_price by product_id` 若**查空**(既有 product 无配对 unit_price)= 数据已损坏,**必须抛错**(与 `getProduct` 既有不变量一致);首插原子性保证该分支理论上不可达。`saveParsed` 返回值结构不变,但等价重复调用**必须**返回**同一对** id(幂等)。

**刷新是新引入的失败面,必须在契约上承认。** 去重命中过去是纯读、不可能失败;现在含一条写。该写失败时 `saveParsed` **必须**抛错(不吞),由既有调用方语义处置(`/contribute` → `500 persistence-error` 且响应附 `rawId`;`/ingest` 后台路径 → 只记日志,沿用既有不重试语义)。此时 raw 已是新价而 `unit_price` 仍是旧值,该态由**下一次重报**收敛;本层**禁止**承诺自动实时收敛。`/contribute` 的成功响应体取自编排的内存结果、**不是**库内行的读回,二者可以不同。

**去重只作用于 `product`/`unit_price` 派生层。** **禁止**因去重改动 `product_raw` 原始留痕或其 `(store, store_sku)` 去重键(原始观察忠实保留);亦**禁止**做跨 `raw` 的「同商品不同标题」实体归一(不同 `rawId` 即不同键、不去重,属已知非目标)。

迁移**必须**经 `drizzle-kit generate` 产出可复现的 sqlite 方言迁移(新增 `dedupe_key` 列 + 唯一索引),沿用既有 `wrangler d1 migrations apply` 路径应用;幂等由 drizzle journal 保证。**空表是唯一自动支持路径**:对空表(生产将整体删除重录的默认路径、harness 用 `:memory:` 空库)直接加 `NOT NULL` 列 + 唯一索引即成功。**非空旧库**(本地已有数据、可能含等价重复行)**不在自动迁移支持范围**——SQLite 非空表加 `NOT NULL` 无 DEFAULT 列直接报错、回填亦撞唯一索引;**禁止**期望 drizzle 单步迁移自动回填/去重(drizzle-kit 不生成数据迁移)。非空旧库**必须**手动处置:直接 drop & re-migrate,**或**先跑可选清理脚本——该脚本**必须在应用层**读每行 `product` 的 spec、调去重键函数算键、按算出的键分组保留 `MIN(rowid)`、删其余及其 `unit_price`,**禁止「按 `dedupe_key` 列分组」**(清理发生在加列之前、该列尚不存在)。清理脚本作为**可选**附件、**禁止**纳入自动部署路径。

#### 场景:同结果重复落库只保留最老一条

- **当** 对同一 `rawId` 用相同 `ParsedSpec` 结果调用 `saveParsed` 两次(同款重复提交)
- **那么** 仅落库一条 `product`(及一条 `unit_price`),第二次调用**不**新增行、返回与第一次**相同**的 `{productId, unitPriceId}`(最老一条);`product` 表该 `dedupe_key` 仅一行;该 `unit_price` 行的五列被本次 `calc` 覆写(等值)

#### 场景:不同解析结果不去重

- **当** 同一 `rawId` 先后产生**不同** `ParsedSpec` 结果(如解析逻辑升级后 `unitSize`/`quantity` 变化)
- **那么** 两者去重键不同、**各自落库**一条 `product`(不互相去重)——去重只收敛「相同结果」

#### 场景:去重键与价格无关

- **当** 同一 `rawId` 同一 `ParsedSpec`、但价格变动导致 `per100ml`/`formula` 不同
- **那么** 去重键**不变**(不含价格派生值)、判为同款重复、`product` 保留最老一条;**禁止**因价格抖动堆叠新「结果」行;而既有 `unit_price` 的 `per100ml`/`formula` **必须**被本次 `calc` 覆写为新价算出的值

#### 场景:去重命中不留 unit_price 孤儿(sqlite path)

- **当** sqlite 驱动 `saveParsed` 在事务内 `insert product onConflictDoNothing` 命中既有 `dedupe_key`(`changes=0`)
- **那么** **不**插入新 `unit_price`(避免指向未插入 product 的孤儿),`SELECT` 既有 `product` 与其既有 `unit_price`、**在同一事务内完成刷新**、返回既有 id 对

#### 场景:D1 并发等价提交保留最老且不留孤儿

- **当** D1 驱动下两个等价提交并发到达(均 SELECT-first 未命中、都进 `batch`),product 用裸 `insert`(无 `onConflictDoNothing`)
- **那么** 先提交方落库(最老);后提交方裸 insert 命中唯一索引**抛错** → 其 `batch` 整体回滚(不留 `unit_price` 孤儿)→ `saveParsed` 捕获后回退 `SELECT` 既有、**对既有 `unit_price` 执行刷新**、返回先提交方(最老)的 id 对;**禁止**用 `onConflictDoNothing` 吞冲突(会使 batch 不抛错、unit_price 成孤儿)

#### 场景:解析置信(confidence)不进去重键

- **当** 同一 `rawId` 同一 `ParsedSpec` 结构、但 `ParsedSpec.confidence` 不同(如 tier2 复算给出不同置信)
- **那么** 去重键**不变**(`confidence` 排除)、判为同款重复、保留最老一条(不因置信抖动堆叠新行)

#### 场景:可空字段归一

- **当** 两次 `saveParsed` 的 `ParsedSpec` 在某可空字段上一为 `null`、一为 `undefined`(其余相同)
- **那么** 二者去重键**相同**、判为同款重复(`null`/`undefined` 归一),只保留最老一条

#### 场景:去重命中刷新既有 unit_price 的派生值

- **当** 对同一 `rawId`、相同 `ParsedSpec`、但**不同 `calc`**(价格变动导致 `per100ml`/`formula`/`warnings`/`confidence` 不同)第二次调用 `saveParsed`
- **那么** `unit_price` 仍只有一行、其 `id` 不变,但五列**必须**已更新为**第二次**调用的 `calc` 值;`product` 行与 `product_raw` 行**逐列未被改写**

#### 场景:刷新不得因价格未变而跳过

- **当** 两次 `saveParsed` 的 `calc` 相同(同价重报)
- **那么** 刷新**必须**照常执行(结果等值);**禁止**引入「与 `product_raw.price` 比较后跳过」之类的条件谓词

#### 场景:三条命中分支的刷新行为一致

- **当** 分别经 sqlite 事务内命中、D1 SELECT-first 命中、D1 抢插失败回退命中三条路径重报同款新价
- **那么** 三者**必须**产生相同的可观察结果(同一 `unitPriceId`、五列均为本次 `calc` 值);**禁止**只在部分分支刷新而造成驱动间行为漂移

#### 场景:不可计算终态照常刷新写回

- **当** 重报使商品从可计算变为不可计算(如新价为 0 / 负),本次 `calc` 的 `per100ml`/`per100g`/`formula` 均为 `null`
- **那么** 既有 `unit_price` 行的这三列**必须**被覆写为 NULL、`confidence`/`warnings` 同步更新;**禁止**保留旧的非空单价与旧 `formula`(该行随之退出 `per100ml` 榜,属预期后果)

### 需求:product_raw 必须维护历史最低价水位(lowest_price)

`product_raw` **必须**新增可空列 `lowest_price`(可移植 `INTEGER`,整数分,语义同 `price`),记录该 `(store, store_sku)` 商品**历次正价观测到的最低整件价**。它是溯源/派生增列、**不在** `RawProductSchema` 内,与领域列正交。它是 `product_raw` 首个**跨观测运行聚合**列(既有列都是当次/首次观测的时点属性),故 `productRaw` docstring 须点明这一新语义。

- **仅正价入水位(硬约束)**:`RawProductSchema` **放行 ≤0/负价**(`product_raw` 忠实存含异常价的原始观察,由 core 路由到 per100ml=null)。若把 0/负价折进 `min`,水位会被**永久毒化**(`min` 单调只降),(本变更前此处的举例是「叠加 `unit_price` first-write-wins 使已入榜项恢复价后显示历史低 ¥0.00」;该举例**已失效**——去重命中刷新落地后,一次 ≤0 观测会把 `per100ml` 刷成 NULL 而使该行**整条退出榜单**,不会以「历史低 ¥0.00」的形态留在榜上。硬约束本身**不变**,理由收窄为:水位是 `product_raw` 的跨观测聚合,`min` 单调只降、毒化**不可逆**。)故水位维护与回填**必须只纳入 `price > 0` 的观测**,`price <= 0` 的观测**禁止**改动或初始化水位。
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

