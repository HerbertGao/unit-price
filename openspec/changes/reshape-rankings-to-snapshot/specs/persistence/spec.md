## 移除需求

### 需求:repository 必须提供 listRankings 只读榜单查询契约

**Reason**: `/rankings` 改为全量快照、`/compute` 的 cohort 定位亦改读同一份快照后,该节点作用域分页查询的生产消费者归零。它连同 `buildRankingsQuery` / `ListRankingsInput` / `RawRankingRow` 与其单测一并删除——留着只会让读者以为服务端仍支持按节点分页取榜。

**Migration**: 节点作用域的取数由「取全量快照 + 客户端按 `parentSlug` 链过滤」承担(见 `api-client` 的 `cohortSlugs` / `rowsInCohort`)。两项能力单独交接:

- **入榜过滤与去重**:由新增的全量快照查询承担(两门 + 按 `unit_price.id` 聚合 slug),见本规范新增需求。
- **查询计划基线**:节点分页查询的基线随之退役;删除前必须先为全量快照查询建立独立基线,避免热路径出现无计划守卫的窗口。

### 需求:repository 必须提供品类树 + 每节点可排名计数的只读查询

**Reason**: 服务端 `rankableCount` 没有现有消费者,且其物化闭包计数无法诚实保证等于快照按父链与完整 wire 准入派生的实际榜行数。保留参考值会误导,保证严格一致则为无消费者能力引入额外数据与运维复杂度。

**Migration**: 由本规范新增的树-only 查询取代。节点保留 `slug` / `name` / `parentSlug` / `comparableUnit` / `rankable`;需要实际行数的客户端从同一份榜单快照派生。

## 新增需求

### 需求:repository 必须提供全量榜单快照的只读查询契约

`@unit-price/db` 必须为 `/rankings` 提供不分页、无节点作用域的只读查询:返回全部可比行,每行附带其**全部** category slug,并附 taxonomy 节点。

**入榜两门**:`rankable = true` ∧ `per100ml IS NOT NULL`。

**没有叶性门。** `attachTag` 已在写入侧强制叶粒度(非叶挂载直接抛),故唯一能产生非叶挂载的是 taxonomy 演化——一个叶后来长出子节点。那些商品仍在售,把它们剔除等于在一次 taxonomy 编辑里静默丢掉在售行。归属由 `categorySlugs` 承载,判据是「任一 slug 是目标节点或其后代」,对叶与非叶一致成立。

**单个成员缺陷不得升级为整查询失败**:不满足行不变量或 wire 必填字段的行、以及不满足节点字段 schema 的节点,必须被排除并按 reason 计数;引用被排除节点的行随之排除。正常的非成员(`rankable=0`、无可比轴)在 SQL 里就被滤掉,不计入排除计数。

**reason 的生产与传输边界不同**:生产者必须用受类型约束的词表防止拼写错误,当前已知值为 `rankable_without_category_edge` / `warnings_undecodable` / `warnings_wrong_shape` / `formula_missing` / `row_shape_invalid` / `node_shape_invalid`。wire schema 只要求非空字符串,不得复制为封闭枚举;新增健康信号必须可被旧客户端安全忽略,不能否决整份载荷。

**排除集必须覆盖下发契约的全部必填字段**:数据库 `NOT NULL` 不排除空串,故准入必须以共享下发 schema 为最终判据。`/rankings` 与 `/compute` 必须看到同一个准入后集合,否则被榜剔除的成员仍会计入比价的 `rank` 与 `total`。

**每行恰一行**:按 `unit_price.id` 聚合其全部 category slug。不得因双叶发两行,亦不得只取其一。

**装配一致性**:行、归属边、taxonomy 节点是三次读。当前实现按顺序发三条独立读;唯一可制造悬空 slug 的删除 `tag` 路径当前不存在,故撕裂窗口作为已知接受项。出现删除 `tag` 的写路径时必须收进一次一致性 `batch()` / 事务。响应侧对象级断言是兜底。

**排序**:`per100ml` 升序、`unit_price.id` 升序。下发即全序,客户端只过滤与切片、不重排。

**节点集不带 `rankableCount`**:`/rankings.categoryNodes` 与 `/categories.nodes` 使用同一无计数投影。需要数量的客户端从快照派生。

**查询计划口径**:本查询无 `LIMIT`、含 slug 聚合,必须有自己的计划契约,不得沿用已删除节点分页查询的基线。

#### 场景:返回全部可比行且每行携带全部 category slug

- **当** 调用全量快照查询
- **那么** 返回全部满足两门的行、不分页;每行携带非空的 category slug 数组
- **当** 某商品挂两条 category 叶边
- **那么** 结果中恰有一行,其 slug 数组同时含两个 slug

#### 场景:非叶挂载的行必须留在快照内

- **当** 某 `rankable` 行只挂在一个非叶节点上(taxonomy 演化留下的历史挂载)
- **那么** 该行必须照常出现在快照中;不得因挂载点不是叶而被排除

#### 场景:不合规行被排除且不使查询失败

- **当** 库中存在无 category 归属、`warnings` 损坏、`formula` 为空或不满足 wire 行 schema 的入榜候选
- **那么** 该行被排除并按 reason 计数,查询照常成功返回其余行

#### 场景:不合规节点被排除且不使查询失败

- **当** 某 category 节点不满足共享节点 schema
- **那么** 该节点及引用它的行被排除并计入 `node_shape_invalid`,其余快照照常返回

#### 场景:排除计数不包含正常的非成员

- **当** 库中存在 `rankable=0` 或无可比轴的行
- **那么** 它们在 SQL 里被滤掉,不计入排除计数

#### 场景:装配一致性与其已知接受的撕裂窗口

- **当** 核对三条读是否在一次一致性读内
- **那么** 当前顺序三读在现有写路径下不可制造悬空 slug;出现删除 `tag` 的写路径时必须改为一次一致性读

#### 场景:全量快照与节点查询的计划契约相互独立

- **当** 核对查询计划基线
- **那么** 全量快照查询必须有独立基线,不得以树-only 查询或已删除分页查询的计划代替

### 需求:repository 必须提供品类树只读查询

`@unit-price/db` 必须提供只读品类树查询,返回全部 `kind=category` 节点并在一次加载后沿 parent map 解析继承的 `comparableUnit`;不得逐节点串行查询。每节点只含 `slug` / `name` / `parentSlug` / `comparableUnit` / `rankable`,其中 `rankable = comparableUnit !== null`;不得返回 `rankableCount`。查询不得写库、解析商品或计算单价。

#### 场景:返回完整 category 树且不返回计数

- **当** taxonomy 已播种并调用树查询
- **那么** 返回全部 category 节点及继承后的 `comparableUnit` / `rankable`,任一节点均不含 `rankableCount`

#### 场景:未 seed 时返回空节点集

- **当** `tag` 表无任何 `kind=category` 行
- **那么** 查询返回空节点集,不得报错

## 修改需求

### 需求:product_raw 必须维护历史最低价水位(lowest_price)

`product_raw` **必须**新增可空列 `lowest_price`(可移植 `INTEGER`,整数分,语义同 `price`),记录该 `(store, store_sku)` 商品**历次正价观测到的最低整件价**。它是溯源/派生增列、**不在** `RawProductSchema` 内,与领域列正交。它是 `product_raw` 首个**跨观测运行聚合**列(既有列都是当次/首次观测的时点属性),故 `productRaw` docstring 须点明这一新语义。

- **仅正价入水位(硬约束)**:`RawProductSchema` **放行 ≤0/负价**(`product_raw` 忠实存含异常价的原始观察,由 core 路由到 per100ml=null)。若把 0/负价折进 `min`,水位会被**永久毒化**(`min` 单调只降且不可逆)。故水位维护与回填**必须只纳入 `price > 0` 的观测**,`price <= 0` 的观测**禁止**改动或初始化水位。
- **列必须可空**;经标准 `drizzle-kit generate` DDL 迁移加列并登记 `_journal.json`。prod 非空表增加可空 `INTEGER` 列不得要求 DEFAULT;同一迁移文件必须执行 `UPDATE product_raw SET lowest_price = price WHERE price > 0 AND lowest_price IS NULL`。`WHERE ... IS NULL` 使回填自幂等,不得把已累积的真实低点重置回当前价;`price > 0` 排除异常价存量。
- **`upsertRaw` 必须维护水位**:首次插入写 `lowest_price = (price > 0 ? price : NULL)`;对 `(store, storeSku)` 冲突时,新价为正才折进 `lowest_price = CASE WHEN 新价 > 0 THEN min(coalesce(lowest_price, 新价), 新价) ELSE lowest_price END`。`title` / `price` / `captured_at` 仍随最新观测覆写,水位对正价只降不升。
- **禁止**用价格历史明细表实现:本列只承载「历史最低价」这一标量,不保留逐次流水。
- **全量榜单快照读投影必须透出水位**:读路径必须投出 `lowest_price` 为 `lowestPriceCents`,并以 `COALESCE(lowest_price, price)` 取值,使结果恒为整数。客户端仅当 `priceCents > lowestPriceCents` 才呈现「历史低」;退化为当前价时不呈现,异常价也不得被当作历史低。投影只读、不重算 `per100ml` 或 formula。

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
- **那么** `product_raw.price` 忠实更新为异常价、但 `lowest_price` **必须**保留 `990`;若某款仅有过 ≤0 观测,其 `lowest_price` **必须**为 `NULL`

#### 场景:加列迁移对非空 prod 表安全并仅回填正价存量为当前价

- **当** 生产经自动 migrate 应用该加列迁移
- **那么** `product_raw.lowest_price` **必须**以可空 `INTEGER` 落地、不破坏既有数据;同迁移的回填必须把每条 `price > 0` 且水位为空的存量行初始化为当前价,`price <= 0` 保持 `NULL`,并可安全重放

#### 场景:读投影经 COALESCE 恒为整数

- **当** 全量榜单快照读投影读取某行(其 `lowest_price` 因无正价历史或回填前边角态为 `NULL`)
- **那么** 投出的 `lowestPriceCents` **必须** = `COALESCE(lowest_price, price)`(退化为当前价),**禁止**透出 `NULL`;正常有正价水位的行直接取 `lowest_price`
