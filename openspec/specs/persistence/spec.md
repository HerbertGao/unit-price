# persistence

## 目的

定义 `@unit-price/db` 持久层：以 `@unit-price/core` 领域类型为单一事实源、用 SQLite↔Postgres 可移植类型落库原始上报（`product_raw`）、规范商品（`product`）、计算结果（`unit_price`）与人工纠错（`corrections`），并提供类型化 repository 契约、可复现迁移与不依赖外部数据库的本地测试基座。本节为待定占位，详见各需求。
## 需求
### 需求:schema 必须以 core 领域类型为单一事实源

`@unit-price/db` 落库的**领域字段必须**与 `@unit-price/core` 的 `RawProduct` / `ParsedSpec` / `CalcResult`(calculator 输出)字段**同名同义、无丢失**;各表可加**显式溯源/外键/时间戳增列**(`store`/`source`/`captured_at`/`raw_id` 等),这些**不属**领域类型、**必须**与领域列区分标注(不得用增列冒充领域字段,也**不得反过来声称表与领域类型「一一对应」**——表是领域字段的超集)。落库前**必须**用 core **已导出**的 Zod schema 校验领域部分:`RawProductSchema` / `ParsedSpecSchema` / 嵌套单价 `UnitPriceSchema` / `WarningsSchema`;`CalcResult` 在 core **无导出 schema**,其 `confidence` 按 `z.number().min(0).max(1)`、`warnings` 按 `WarningsSchema`、嵌套 `unitPrice` 按 `UnitPriceSchema` 校验。校验失败**必须**拒绝写入并抛出带字段路径的错误(禁止静默落脏数据)。Zod 校验始终对**领域对象**(解码后),而非对存储编码后的 JSON 串。`Measurement`(value+unit)**必须**拆成可查询的两列(`unit_size_value` REAL / `unit_size_unit` TEXT)。`multipliers` 与 `warnings` 数组**必须**以 **JSON-text(`TEXT` 列存 JSON 串)** 存储(**禁用**原生数组/jsonb,见可移植类型需求)、内容可无损往返(含空数组);两者**均为 `NOT NULL` 列**——`multipliers` 因 core 侧 `.default([1])`、`warnings` 因 `CalcResult.warnings` 恒非 null 数组且 `WarningsSchema` 拒 null,故都无可空态、**不引入「`[]` vs NULL」区分**(空数组存 JSON 串 `"[]"`)。`ParsedSpec` 的可选+可空字段(`unitSize`/`totalAmount`/`quantity`/`packageUnit`)落库时 `undefined`(字段缺失)与 `null` **均归一为列 NULL**;往返「相等」按此归一判定(读回为 `null`,与写入的 `undefined`-或-`null` 语义等价)。

#### 场景:Zod 校验通过则落库
- **当** repository 收到一个通过 `ParsedSpecSchema` 校验的对象
- **那么** 写入对应表,各字段按列映射,measurement 拆为 value/unit 两列,读回后能无损重建为同一 `ParsedSpec`(可选字段的 `undefined`/`null` 归一为 NULL,见上)

#### 场景:Zod 校验失败则拒写
- **当** 传入对象不满足 core schema(如 confidence 越界、unit 非法)
- **那么** repository **必须**抛出带字段路径的错误、**禁止**写入任何行

#### 场景:数组列无损往返
- **当** 落库 `multipliers=[1,2]`(用例仅验列往返能力,非 core 本期产值——本期恒 `[1]`)与 `warnings=[]`(均 NOT NULL)再读回
- **那么** 读回值内容与写入**严格相等**(空数组照常往返为空数组),两列均无 NULL 态

### 需求:schema 必须用 SQLite↔Postgres 可移植类型

引擎为 **Cloudflare D1(SQLite)**。schema **禁止**使用 Postgres-only 类型(原生数组、`jsonb`、`serial`、`numeric`),只用在 SQLite 与 Postgres 上**语义等价**的类型,使日后撑爆 D1 时可平滑迁 Postgres(repository 契约 + core Zod SOT 不变,仅换方言包壳)。类型映射**必须**为:
- **主键/外键**:**app 生成的 `TEXT` id(UUID 或 ULID)**,**禁用** `serial`/自增整数 PK(自增 PK 在 SQLite=`INTEGER PK`、PG=`identity/serial`,不可移植;app 生成 TEXT id 两边等价,且契合多源众包 ingest 无需中心自增)。`raw_id`/`product_id` 等 FK 同为 `TEXT`。
- 数组/JSON 载荷(`multipliers`/`warnings`/`corrected_spec`)→ JSON-text(`TEXT`)。
- 金额(`price`)→ **整数分(`INTEGER`,精确)**;换算**必须**为 `分 = Math.round(元 × 100)`、`元 = 分 / 100`,**禁止** `trunc`/`floor`/`| 0`(JS 浮点 `0.29 × 100 = 28.9999…`,截断会得 28、少计 1 分,需 `Math.round` 得 29;`0.57`/`1.13`/`19.90` 同类。注:`39.90 × 100` 恰为精确 3990,不是 off-by-one 例)。
- 派生比值(`per100ml`)→ `REAL`;`confidence` → `REAL`;时间戳 → `INTEGER` epoch(或 ISO `TEXT`);`category`/`store`/`store_sku`/`*_unit`/`formula` → `TEXT`。
数组/JSON 与金额在 repository 工具层做 `JSON.parse`/`stringify` 与 `Math.round` 分↔元换算——这是**存储定标编码**、**非领域计算**;core 仍是价格/单位换算/可比的**唯一来源**,repo 不引入任何领域判断。

#### 场景:无 Postgres-only 类型
- **当** 检查生成的迁移 SQL / schema
- **那么** **禁止**出现原生数组列(`...[]`)、`jsonb`、`serial`、自增整数 PK、`numeric` 等 SQLite 不支持或非等价的类型;主键为 app 生成 `TEXT` id

#### 场景:金额换算钉死四舍五入(防 off-by-one)
- **当** 落库 `price = ¥0.29`(`0.29 × 100 = 28.9999…` 的浮点漂移值)
- **那么** **必须**经 `Math.round` 存为 **29 分**(而非截断得 28),读回 `0.29`;`¥0.57 → 57`(截断会得 56)同为判别例;`¥39.90 → 3990`(此值 trunc=round 恰精确,仅作 passthrough 断言)。**禁止**用 float 存金额或用截断换算

### 需求:product_raw 必须落地每次上报并按去重键收敛

`product_raw` **必须**存下每次抓取/录入的原始商品(`store`、`store_sku`、`title`、`price`、`category_hint`(可空,映射 `RawProduct.categoryHint`)、`source`、`source_url`、`captured_at`),作为 ingest 的落地表。去重键**必须**为 `(store, store_sku)`(确定性、与价格无关——价格变动算同款更新而非新行)。`store`/`store_sku` 是溯源增列、**不在** `RawProductSchema` 内,故 `upsertRaw` **必须额外**校验二者非空(空串/缺失即拒写)、且两列在 schema 中为 `NOT NULL`——否则空 `store_sku` 会让无 SKU 上报坍缩成一行、破坏键的确定性。`title`/`price` 属 `RawProductSchema` 必填(`z.string().min(1)`/`z.number()`),其列亦**必须**为 `NOT NULL`——使列约束与 core 非空事实源在 schema 层(而非仅 repository parse)闭合,旁路直写也不能落空 title/price。注:`RawProductSchema.price=z.number()` **放行 ≤0/负价**(正价约束属 core 计算层——负价/0 价由 core 路由到 per100ml=null,**非落库层**职责);`product_raw` 忠实存原始观察(含异常价),`price` 列只 `NOT NULL`、不强制正值。同键再次上报**必须** upsert(更新 `price`/`captured_at` 等而非堆叠重复行),保留 `captured_at` 以追溯最近一次观察。本表**禁止**做规格解析或单价计算(只存原始事实)。

#### 场景:同款商品重复上报
- **当** 同一 `(store, store_sku)` 的商品被上报两次
- **那么** `product_raw` 中只保留一行,`captured_at` 与价格更新为最近一次

#### 场景:原始表不含派生字段
- **当** 检查 `product_raw` 的列
- **那么** 其中**禁止**出现 `per100ml`、`unit_size` 等解析/计算派生字段(这些归 `product`/`unit_price`)

#### 场景:去重键字段为空则拒写
- **当** 上报的 `store` 或 `store_sku` 为空串/缺失
- **那么** `upsertRaw` **必须**拒写并抛错(禁止用空 `store_sku` 落库,以免坍缩破坏去重键确定性)

### 需求:product 必须存规范商品且预留品类扩展位

`product` **必须**由 `ParsedSpec` 派生落库(`unit_size_value`/`unit_size_unit`、`quantity`、`multipliers`、`total_amount_*`、`package_unit`、`category`、`confidence`),并**必须**经 `raw_id` 外键关联到产生它的 `product_raw` 行。此处 `confidence` 为 **`ParsedSpec.confidence`(解析置信,中间值)**,与 `unit_price` 的最终权威置信(见下需求)是**两个不同的值**、语义不同。本次 `category` **必须**保持为现有的自由 string(恒 `beverage`)——品类真值改由 `category-tagging` 的 `product_tag` 承载,`spec-parsing` 的 `category` 恒常量约束本期不变;可空字段**必须**用 nullable 列,使部分 tier1 命中能落库。

**本期(`category-tagging`)引入品类表与扩展列**:**必须**新增 `tag` / `product_tag` / `store_category_map` / `category_closure` 四表,并给 `product` 增 `pending_category_tag_id`(可空,「粗分类 / 待细化」非叶终态指针,引用 `tag`)与 `rankable`(派生)两列。这些表 / 列**必须**沿用本规范的可移植类型(app 生成 TEXT 主键、JSON-text、INTEGER、REAL;无 Postgres-only 类型)。`tag.comparable_unit` **必须可空**;`product_tag.confidence` 为 REAL、`product_tag.source` 为 TEXT 枚举(本期 `{rule, store-map, manual}`);`(product_id, tag_id)` 与 `(store, native_category_id)` 各为唯一键。

**非空旧库迁移安全(B1)**:`product.rankable` **必须**以 `INTEGER NOT NULL DEFAULT 0` 加列——生产 `product` 为非空表(现状约 445 行)、且 push main 自动 migrate,**SQLite 非空表加无 DEFAULT 的 `NOT NULL` 列会直接报错**(对齐既有「迁移可复现 / 非空旧库」纪律);加列即全 `0`,随后由 `category-tagging` backfill `UPDATE` 重算到正确值。`pending_category_tag_id` 加列为可空(无此问题)。

**两新列不进去重键**:`pending_category_tag_id` / `rankable` 是**溯源 / 派生增列**(类同 `raw_id` / `dedupe_key`),**禁止**进入 `dedupe_key`、**不影响**既有 first-write-wins 去重收敛(与「键与价格无关、`confidence` 不进键」同口径)。

其余语义与不变量(单归属 / `comparable_unit` 继承 / 闭包 / 仲裁 / `rankable` 派生 / 三态)由 `category-tagging` 能力定义。**仍禁止** `comparison_group` 表(对比组改动态查询,见 taxonomy §九)。

#### 场景:部分规格命中也能落库
- **当** 一个只命中 `unitSize`、`quantity` 为 null 的 `ParsedSpec` 落库
- **那么** 写入成功,`quantity` 列为 NULL,读回得到同一部分规格

#### 场景:product 关联其来源 raw
- **当** 落一个 `product`
- **那么** 其 `raw_id` **必须**指向真实存在的 `product_raw` 行,可经 product 取回原始上报

#### 场景:引入品类表(comparison_group 仍不物化)
- **当** 应用本次迁移后检查 schema
- **那么** **必须**存在 `tag` / `product_tag` / `store_category_map` / `category_closure` 四表,以及 `product.pending_category_tag_id` / `product.rankable` 两列(均用可移植类型);**仍不存在** `comparison_group` 表(对比组动态查询)

#### 场景:非空旧库加 rankable 列不炸迁移
- **当** 在已有数据的 `product` 表(非空)上应用本次迁移
- **那么** `rankable` 以 `INTEGER NOT NULL DEFAULT 0` 加列、迁移**必须**成功(不因「非空表加无 DEFAULT 的 NOT NULL 列」报错);已有行 `rankable` 初值为 `0`,待 backfill 重算

#### 场景:加两列不改去重收敛
- **当** 加入 `pending_category_tag_id` / `rankable` 两列后对同款商品重复落库
- **那么** `dedupe_key` 构造**必须**不含这两列、既有 first-write-wins 去重收敛行为不变(保留最老一条)

### 需求:unit_price 必须存计算结果并保留可空与留痕

`unit_price` **必须**关联 `product` 存 **`CalcResult`(calculator 输出)**:嵌套单价 `per100ml`(可空 `REAL`)/`per100g`(可空 `REAL`)/`formula`(可空 `TEXT` 公式留痕)对齐 `UnitPrice`,加 `CalcResult` 的 `confidence`(**最终权威置信 band**,`REAL`,与 `product.confidence` 的解析置信是不同的值)与 `warnings`(JSON-text 数组)。`per100ml`/`per100g` **必须从 core 的 `CalcResult` 输出直存**,**禁止**在 repo 层用库内整数分 `price` 重算(core 从原始元价算出,重算会引入单位/精度错)。`per100ml` 与 `per100g` 表达商品所属**轴**:容量轴 `per100ml` 非空、重量轴 `per100g` 非空,二者**恰一非空**(都为 NULL = 该商品确定不可计算)、**禁止**两列同时非空(一个商品至多一条轴)。落库前的 `CalcResult` 校验门(`repository.ts` 的 `CalcResultGate`)**必须**把既有「`per100ml` 与 `formula` 同空同设」不变量推广为:**`formula` 非空 当且仅当 `per100ml`/`per100g` 之一非空**(可算→该轴单价与 `formula` 同设、另一轴 NULL;不可算→`per100ml`/`per100g`/`formula` 三者全 NULL),且 `per100g` 非空时**必须**有限(`Number.isFinite`,禁 `NaN`/`Infinity`)、`per100ml`/`per100g` **禁止**同时非空。**禁止**沿用仅校验 `per100ml⟺formula` 的旧门(会把重量可算结果`{per100ml:null, per100g:非空, formula:非空}`误判为非法而拒写)。`formula` 是 core 原样留痕、内嵌**元**价(如 `"39.9 / 660 * 100"`),自包含、可独立回放;它与 `price` 列的整数分口径差 `price/100`(回放用 formula 串本身,不代入 price 列);两套金额(formula 内元价 vs price 列分值)**各自独立留痕、不做跨表交叉校验**。「确定不可计算」**必须**以 `per100ml = per100g = NULL` 表达(禁止用 0 或缺行冒充)。`per100ml`/`per100g` 列**必须**可被索引/数值排序(支撑未来分轴榜单查询;`REAL` 数值排序而非字典序)。

#### 场景:容量轴可算商品

- **当** core 算出 `per100ml` 与 `formula`(容量轴)
- **那么** 落 `unit_price` 一行,`per100ml`/`formula` 非空、`per100g` 为 NULL,confidence/warnings 一并存

#### 场景:重量轴可算商品

- **当** core 算出 `per100g` 与 `formula`(重量轴,如 `水蜜桃 2kg`)
- **那么** 落 `unit_price` 一行,`per100g`/`formula` 非空、`per100ml` 为 NULL,confidence/warnings 一并存

#### 场景:确定不可计算

- **当** core 判定 `per100ml = per100g = null`(如价格≤0、无 size 或未知单位)
- **那么** `unit_price.per100ml` 与 `per100g` 列均为 NULL、`formula` 为 NULL,**禁止**写成 0

### 需求:corrections 必须沉淀人工纠错样本

`corrections` **必须**记录人工纠错(关联 `product`/`product_raw`、`corrected_spec`、`parse_source = manual_corrected`、时间戳),供未来作为 few-shot 样本与 eval 真值。`corrected_spec` **必须**为一个 **`ParsedSpec` 形 JSON(JSON-text,`TEXT` 列)**——即纠错后的规范规格,落库前**必须**过 `ParsedSpecSchema` 校验(故 `saveCorrection` 的入参是类型化的、与 core 类型对齐,不是无定形载荷)。纠错**禁止**就地覆盖原 `product_raw`/`product`(原始事实与原解析不可篡改),**必须**以独立纠错行表达。

#### 场景:提交一次纠错
- **当** 用户提交一个纠错后的 `ParsedSpec`
- **那么** 新增一行 `corrections`(`corrected_spec` 经 `ParsedSpecSchema` 校验、parse_source=manual_corrected),原 `product_raw`/`product` 行保持不变

### 需求:数据访问层必须提供类型化契约且配置缺失时显式失败

`@unit-price/db` **必须**导出类型化 repository 接口(至少:`upsertRaw`、`saveParsed`、`getProduct`、`saveCorrection`),入参/出参类型与 core 的 Zod 推导类型一致,读出对象**必须**经 Zod 再校验。`saveParsed` 入参**必须**含 `ParsedSpec` + `CalcResult` + `raw_id` 关联,落库前**必须**分别校验(`ParsedSpec` 过 `ParsedSpecSchema`;`CalcResult` 拆开过 `UnitPriceSchema`/`WarningsSchema`/`z.number().min(0).max(1)`),并在**单事务内**写 `product` + `unit_price`(全成或全败,不留孤儿)。`getProduct` 的「关联」**必须**明确为:返回 `product`(类型化 `ParsedSpec`)+ 其 `unit_price`(`CalcResult` 形)+ 可追溯的 `raw_id`。DB 连接(D1 binding 或本地 SQLite 句柄)缺失/打不开时,repository 初始化**必须**抛出明确错误(禁止静默连空库或假成功)。repository **必须**接受注入连接(D1 binding 或 sqlite 句柄),不在本层耦合 binding 获取方式。错误的 HTTP 状态分类(4xx/5xx)归 `public-deploy`,本层只抛类型化错误。

#### 场景:连接串缺失
- **当** 初始化 repository 时未提供有效 DB 连接(D1 binding/SQLite 句柄缺失或打不开)
- **那么** **必须**抛出指明连接缺失的错误,**禁止**返回一个看似可用的空实例

#### 场景:读出对象类型化
- **当** `getProduct` 返回一行
- **那么** 返回值是经 Zod 校验的 `ParsedSpec` + 其 `unit_price`(`CalcResult` 形)+ `raw_id`,而非裸数据库行

### 需求:repository 必须提供 listRankings 只读榜单查询契约

`@unit-price/db` 的 repository **必须**提供只读方法为榜单消费（`rankings-api` 的 `GET /rankings`）提供按可比单价升序的分页查询。**P3 升级**：该查询由 P2 的「全局扁平、`category` 不下推」改为**品类节点作用域**——`category` 入参解析为 taxonomy 节点、驱动闭包过滤，并读取 `product.rankable` 作入榜门。方法是既有「至少 `upsertRaw`/`saveParsed`/`getProduct`/`saveCorrection`」契约的**扩充**（既有方法语义不变）。

**只读与不重算**：**必须只读**——禁止写库、禁止触发解析/计算。投影中的 `per100ml`、`formula`、`confidence`、`warnings` **必须直接取 `unit_price` 已存储列**，**禁止**在读路径用库内整数分 `price` 重算（与既有「`per100ml` 必须从 `CalcResult` 直存、禁止 repo 重算」同口径，保证留痕一致）。闭包 / `rankable` 仅作**过滤**，不参与重算。

**入榜过滤与轴（P3 收敛，取代 P2「per100ml 唯一判据、category 不下推、不读 rankable」）**：一行入榜当且仅当**三者皆真**：① 它是目标品类节点的闭包成员（`product_tag`(kind=category 叶) JOIN `category_closure.ancestor_tag_id = 目标节点`）；② `product.rankable = true`；③ `unit_price.per100ml IS NOT NULL`。数据门列由可排名成员轴决定、v1 一律 per100ml（`rankable=true ⟹ 成员 comparable_unit=per_100ml`，故对任一节点含 root 一律 `per100ml IS NOT NULL`；详见 `rankings-api`）。**`category` 现下推为闭包过滤**（非 P2 的 no-op）；`product.category` 列（恒 `beverage`）**仍禁止**用作入榜判别。`per100ml`/`per100g` 仅有 per100g 的重量品、确定不可计算项、`rankable=false`（酒类叶/待细化/待人工）一律**排除**。

**闭包 JOIN 去重（防御性，单归属是应用层不变量非 DB 约束）**：`category_closure` 仅含 category is-a 边，故 `category_closure.tag_id = product_tag.tag_id` 的 JOIN 天然只匹配 category 叶边。单归属（每商品至多一叶）是写时（`attachTag`/`reconcileCategory`）应用层强制、**非** DB 约束（`product_tag` 唯一键是 `(product_id, tag_id)` 全对，不阻止叶+祖先并存）。故节点榜查询**必须**对 `unit_price.id` 加 `SELECT DISTINCT` 兜底（对齐既有 `listProductIdsInCategoryNode` 的 `selectDistinct`），使任一未来双叶缺陷不致重复列出同一商品。

**排序与查询计划口径（P3 节点路径；取代 P2「主序必走 unit_price_per100ml_idx」要求）**：**必须**按 `unit_price.per100ml` 升序为主排序键、`unit_price.id` 升序为次级键（同表确定全序、分页稳定；**禁用**跨表 `product.id`）。**节点路径的查询计划契约（驱动表全扫、`category_closure` 与 `unit_price` 经各自唯一键 `SEARCH ... USING INDEX`、允许 temp B-tree、EXPLAIN 护栏按表 substring 断言并先 `ANALYZE`、不加 `category_closure(ancestor_tag_id, tag_id)`）以 `rankings-api`「节点路径的查询计划口径」节为单一事实源——本规范不重述、以免双写漂移**；持久层只额外固定：① 该计划契约是 repository 这条查询的实现约束；② 节点查询带 `category_closure.ancestor_tag_id=:node` 与 `product.rankable=1` 两等值过滤，配 `SELECT DISTINCT unit_price.id`（见上去重段）。v1 规模（~445 product、闭包 ~35 行、~13 节点）下整体 sub-ms、**可接受**。

**投影形状与校验口径**：返回**反规范化只读投影**（join `unit_price ⋈ product ⋈ product_raw ⋈ product_tag ⋈ category_closure` 后取展示列：`unit_price` 的 `per100ml`/`formula`/`confidence`/`warnings`、`product_raw` 的 `title`/`price`(整数分)/`store`/`store_sku`/`source_url`），**不是**领域对象。榜单投影契约校验由消费端 `rankings-api` 的 `RankingsResponseSchema` 在 API 层承担。`confidence` **必须**取 `unit_price.confidence`（最终权威 band）、**禁止**误取 `product.confidence`。`warnings` 以 JSON-text 存储、投影**必须**经 `decodeJson` 还原并经 `WarningsSchema` 校验为 `string[]`、**禁止**透出原始串；损坏列**必须** fail-closed 抛错（致整体抛 → handler `500`），不静默丢行/返回部分结果。「读出领域对象必须经 Zod 再校验」对 `getProduct`/`saveCorrection` 等**仍有效**；本榜单投影是非领域投影、校验落 API 层、并存不冲突。

#### 场景:按品类节点闭包 + rankable + per100ml 升序分页

- **当** 调用节点榜查询（`category='carbonated'`，库中含碳酸叶 rankable 软饮、其它叶软饮、`rankable=false` 行、`per100ml=NULL` 行）
- **那么** **必须**只返回碳酸节点闭包下 `rankable=true ∧ per100ml` 非空的成员、按 `per100ml` 升序、同值按 `unit_price.id` 升序，切片 `[offset, offset+limit)`；非该节点成员、`rankable=false`、`per100ml=NULL` 的行**必须不出现**

#### 场景:默认 root（beverage）= 全部可排名软饮、酒类经 rankable 门排除

- **当** 调用 `category='beverage'`（root），库中含可排名软饮与有 per100ml 的酒类（`rankable=false`）
- **那么** 结果**必须**含全部可排名软饮（闭包到 root）、**必须不含**任何 `rankable=false` 行（含有 per100ml 的酒类）；`product.category` 列**不**参与判别

#### 场景:违反单归属（同商品双叶）仍至多一行

- **当** 某商品违反单归属、挂两条 category 叶边且都命中目标节点
- **那么** 该商品在结果中**必须**至多出现一次（`SELECT DISTINCT unit_price.id` 兜底）、不重复

#### 场景:per100ml/formula/confidence 取存储值不重算且 confidence 取权威列

- **当** 某行 `unit_price.per100ml = 0.505`、`formula = "40 / (330 * 24 * 1) * 100"`、`unit_price.confidence = 0.95`，而其 `product.confidence`（解析中间值）= `0.5`
- **那么** 投影行的 `per100ml`/`formula` **必须**等于 `unit_price` 存储值（未重算），`confidence` **必须**等于 `0.95`（`unit_price.confidence`），**禁止**返回 `0.5`

#### 场景:同 per100ml 分页稳定且计划走有效护栏

- **当** 多行 `per100ml` 相同，分两次取同一节点榜（`offset=0` 与 `offset=N`，limit=N，两次间数据不变）
- **那么** 两次结果**必须**按 `unit_price.id` 升序不重叠不遗漏地覆盖这些同值行；EXPLAIN（先 `ANALYZE`）中 `category_closure` 与 `unit_price` **必须** `SEARCH ... USING INDEX`（不退化为 SCAN），**允许** temp B-tree 与驱动表全扫

### 需求:迁移必须可复现且本地测试不依赖外部数据库

变更**必须**提供 Drizzle 迁移(sqlite 方言,可由 schema 生成、可应用),并提供本地测试基座(in-memory SQLite,如 `better-sqlite3`/`@libsql/client`,或 Miniflare D1),使 `pnpm -r test` 在 CI/本地**无需**外部托管数据库即可跑通持久层测试,且与生产 D1 同方言(SQLite)。测试基座**必须**显式 `PRAGMA foreign_keys=ON`(裸 SQLite 默认 OFF、驱动行为可能随版本/换型漂移,显式 ON 与 D1 强制 FK 对齐)——否则 `saveParsed` 单事务的 FK 回滚原子性会**假绿**(测试库不校验 FK 则回滚断言测不出);单事务原子性测试的失败注入**必须**用在测试库上确实生效的手段(`mock` 抛错或 NOT NULL/FK 约束,且 FK 已开)。重复运行迁移**必须**幂等——幂等由 **drizzle migration journal**(`__drizzle_migrations` 记录已应用的迁移、再次 `drizzle-kit migrate` 时跳过)保证,**而非**依赖 `CREATE TABLE IF NOT EXISTS`(drizzle-kit 默认生成裸 `CREATE TABLE`)。

#### 场景:本地跑持久层测试
- **当** 在干净环境执行 db 包测试
- **那么** 测试自带/拉起本地 SQLite 实例完成,不要求预置任何外部托管数据库

#### 场景:迁移可重放
- **当** 对同一数据库**重复运行 `drizzle-kit migrate`**
- **那么** migration journal 跳过已应用迁移,schema 收敛到同一状态、不报重复建表错误(不重放同一 SQL 文件)

### 需求:product 必须按去重键收敛、相同结果只保留最老一条

`saveParsed` 落库 `product` 时**必须**对「同一来源 + 相同解析结果」去重:**禁止**为等价的重复输入堆叠多条 `product` 行(否则同一款被未来榜单重复计数/排序、污染真实单价榜)。

**去重键必须为 `(rawId + 规范化 ParsedSpec)`、与价格无关。** 键字段为 `rawId`、`unit_size_value`、`unit_size_unit`、`quantity`、`total_amount_value`、`total_amount_unit`、`category`、`multipliers`、`package_unit`;**禁止**纳入 `per100ml`/`formula`(价格派生值),且键**禁止**涉及 `unit_price` 表任何列(含其 `confidence`/`warnings`)——价格变动属同款更新、不应制造新「结果」行(与 `product_raw` 去重键「与价格无关」同口径)。`ParsedSpec.confidence`(`product.confidence` 列)**亦排除**:它是解析中间置信、非「结果结构」一部分,同 rawId 同 spec 结构、不同 confidence(如 tier2 复算)**必须**判为同款重复、保留最老(不因置信抖动堆叠新行)。键**必须**由确定性纯函数构造(IO 层 / `packages/db` 的独立模块,**禁止**污染 `core`、**禁止**塞入 `codec`):相同 `ParsedSpec` 结果**必须**得相同键、不同结果**必须**得不同键;`null` 与 `undefined` 可空字段**必须**归一为 JSON `null`(**禁止**用字符串哨兵——会与真值字符串碰撞误去重;JSON 规范区分 `null`/数字/字符串);measurement/JSON 序列化**必须直接调用**落库所用的 `encodeMeasurement`/`encodeJson`(**禁止**另写等价序列化,以免漂移);最终键**必须**以结构化数组整体序列化产出(**禁止**裸字符串拼接,以免 `"a|b"` 分隔歧义)。

**保留最老一条必须由数据库唯一约束保证。** `product` 表**必须**新增 `dedupe_key`(`TEXT NOT NULL`)列与其 **`uniqueIndex`**——**首个成功插入的行赢、后到等价行被拒/no-op**,「保留最老」由唯一约束天然保证,**禁止**依赖应用层 rowid 比较或读后写时序。`dedupe_key` 是溯源/收敛增列(类同 `raw_id`),**非**领域字段、不进 `ParsedSpec`。

**双驱动写路径必须各自保证首插原子 + 不留孤儿(机制不同但等效)。**
- **sqlite 驱动**(单连接、无真并发):`saveParsed` **必须**在单个 `transaction` 内 `insert(product)` 用 `onConflictDoNothing(target dedupe_key)` 并判 `changes`/`returning`——真插入(`changes=1`)→同事务内插 `unit_price`、返回新对;命中既有(`changes=0`)→`SELECT` 既有 `product`+`unit_price`、返回既有对、**不**插 unit_price。两插同事务,首插原子。
- **D1 驱动**(有真并发):`saveParsed` **必须** SELECT-first(`SELECT product by dedupe_key`)——命中→返回既有对、不写;未命中→`batch([insert product, insert unit_price])` 原子写,其中 product **必须用裸 `insert`、禁止 `onConflictDoNothing`**。**禁止**对 D1 path 的 product insert 用 `onConflictDoNothing`:它会吞掉唯一冲突使 `batch` 不抛错、`unit_price` 照插成孤儿。并发抢插时裸 insert 命中唯一索引**抛错** → `batch` 全成全败、整体回滚 → `saveParsed` **必须**捕获该错并回退到「SELECT 既有并返回」分支(此时先提交方已落库、必查到)。首插原子由 `batch` 保证。

**去重命中时禁止留孤儿、必须返回既有最老行;回退查空即数据损坏必须抛错。** 命中既有 `dedupe_key` 时,`saveParsed` **必须不**插入新 `unit_price`,而**必须**查既有 `product` 及其 `unit_price`、返回**既有(最老)** 的 `{productId, unitPriceId}`。其中 `SELECT unit_price by product_id` 若**查空**(既有 product 无配对 unit_price)= 数据已损坏,**必须抛错**(与 `getProduct` 既有不变量一致);首插原子性保证该分支理论上不可达。`saveParsed` 返回值结构不变,但等价重复调用**必须**返回**同一对** id(幂等)。

**去重只作用于 `product`/`unit_price` 派生层。** **禁止**因去重改动 `product_raw` 原始留痕或其 `(store, store_sku)` 去重键(原始观察忠实保留);亦**禁止**做跨 `raw` 的「同商品不同标题」实体归一(不同 `rawId` 即不同键、不去重,属已知非目标)。

迁移**必须**经 `drizzle-kit generate` 产出可复现的 sqlite 方言迁移(新增 `dedupe_key` 列 + 唯一索引),沿用既有 `wrangler d1 migrations apply` 路径应用;幂等由 drizzle journal 保证。**空表是唯一自动支持路径**:对空表(生产将整体删除重录的默认路径、harness 用 `:memory:` 空库)直接加 `NOT NULL` 列 + 唯一索引即成功。**非空旧库**(本地已有数据、可能含等价重复行)**不在自动迁移支持范围**——SQLite 非空表加 `NOT NULL` 无 DEFAULT 列直接报错、回填亦撞唯一索引;**禁止**期望 drizzle 单步迁移自动回填/去重(drizzle-kit 不生成数据迁移)。非空旧库**必须**手动处置:直接 drop & re-migrate,**或**先跑可选清理脚本——该脚本**必须在应用层**读每行 `product` 的 spec、调去重键函数算键、按算出的键分组保留 `MIN(rowid)`、删其余及其 `unit_price`,**禁止「按 `dedupe_key` 列分组」**(清理发生在加列之前、该列尚不存在)。清理脚本作为**可选**附件、**禁止**纳入自动部署路径。

#### 场景:同结果重复落库只保留最老一条

- **当** 对同一 `rawId` 用相同 `ParsedSpec` 结果调用 `saveParsed` 两次(同款重复提交)
- **那么** 仅落库一条 `product`(及一条 `unit_price`),第二次调用**不**新增行、返回与第一次**相同**的 `{productId, unitPriceId}`(最老一条);`product` 表该 `dedupe_key` 仅一行

#### 场景:不同解析结果不去重

- **当** 同一 `rawId` 先后产生**不同** `ParsedSpec` 结果(如解析逻辑升级后 `unitSize`/`quantity` 变化)
- **那么** 两者去重键不同、**各自落库**一条 `product`(不互相去重)——去重只收敛「相同结果」

#### 场景:去重键与价格无关

- **当** 同一 `rawId` 同一 `ParsedSpec`、但价格变动导致 `per100ml`/`formula` 不同
- **那么** 去重键**不变**(不含价格派生值)、判为同款重复、保留最老一条;**禁止**因价格抖动堆叠新「结果」行

#### 场景:去重命中不留 unit_price 孤儿(sqlite path)

- **当** sqlite 驱动 `saveParsed` 在事务内 `insert product onConflictDoNothing` 命中既有 `dedupe_key`(`changes=0`)
- **那么** **不**插入新 `unit_price`(避免指向未插入 product 的孤儿),`SELECT` 既有 `product` 与其既有 `unit_price`、返回既有 id 对

#### 场景:D1 并发等价提交保留最老且不留孤儿

- **当** D1 驱动下两个等价提交并发到达(均 SELECT-first 未命中、都进 `batch`),product 用裸 `insert`(无 `onConflictDoNothing`)
- **那么** 先提交方落库(最老);后提交方裸 insert 命中唯一索引**抛错** → 其 `batch` 整体回滚(不留 `unit_price` 孤儿)→ `saveParsed` 捕获后回退 `SELECT` 既有、返回先提交方(最老)的 id 对;**禁止**用 `onConflictDoNothing` 吞冲突(会使 batch 不抛错、unit_price 成孤儿)

#### 场景:解析置信(confidence)不进去重键

- **当** 同一 `rawId` 同一 `ParsedSpec` 结构、但 `ParsedSpec.confidence` 不同(如 tier2 复算给出不同置信)
- **那么** 去重键**不变**(`confidence` 排除)、判为同款重复、保留最老一条(不因置信抖动堆叠新行)

#### 场景:可空字段归一

- **当** 两次 `saveParsed` 的 `ParsedSpec` 在某可空字段上一为 `null`、一为 `undefined`(其余相同)
- **那么** 二者去重键**相同**、判为同款重复(`null`/`undefined` 归一),只保留最老一条

### 需求:repository 必须提供品类树 + 每节点可排名计数的只读查询

`@unit-price/db` 的 repository **必须**新增只读方法（供 `category-tree-api` 的 `GET /categories`）返回 store-agnostic 的 category is-a 树及每节点的可排名计数。该方法**必须只读**、不写库、不解析/计算。

- **节点集与继承**：返回全部 `kind=category` 节点（`slug`/`name`/`parentSlug`）+ 经 is-a 继承解析的 `comparableUnit`（节点自身值，空则沿 parent 取最近非空祖先，至 root 仍空则 null）。继承解析**必须**一次性加载全部 category 节点后在**内存**沿 parent map 求解，**禁止**逐节点串行调按 `parent_id` 往返的 `resolveComparableUnit`（D1 上 O(节点×深度) 次往返）。
- **rankableCount 与节点榜同源**：每节点 `rankableCount` 的过滤谓词（闭包成员 ∧ `rankable=true` ∧ `per100ml` 非空）**必须**与 listRankings 节点榜查询取自**同一份可复用 builder 片段**，`rankableCount` = 在该片段上做 `COUNT(DISTINCT product.id)`；**禁止**两处各自手写谓词。`COUNT(DISTINCT product.id)` 与节点榜（去重于 `unit_price.id`）基数相等**依赖既有不变量 `unit_price` 与 `product` 1:1（`unit_price_product_id_unique`）**——此为承重前提，须显式成立；若未来放松该 1:1，两侧须改用同一 `COUNT(DISTINCT product.id)` 口径。
- **正交语义**：节点自身 `rankable`（= `comparableUnit !== null`）与 `rankableCount`（闭包后代可排名数）**正交**——root `beverage`（`rankable=false`）的 `rankableCount` 可 `> 0`（其后代含可排名软饮）；唯闭包无可排名成员的节点（酒类子树）`rankableCount=0`。**禁止**把节点 `rankable=false` 推成 `rankableCount=0`。
- **未 seed 退化**：`tag` 无 category 行时返回空节点集（不报错）。

#### 场景:返回全 category 节点 + 继承单位 + 每节点可排名计数

- **当** 调用品类树查询，库已 seed 品类树且有若干可排名软饮
- **那么** **必须**返回全部 kind=category 节点（含 root/软饮父/软饮叶/酒类子树），每节点带继承解析的 `comparableUnit`（软饮线 `per_100ml`、酒类/root `null`）与 `rankableCount`；root 的 `rankableCount` **必须** `>0` 且等于默认节点榜基数、酒类节点 `rankableCount=0`

#### 场景:rankableCount 与节点榜基数逐节点相等

- **当** 对每个节点比较其 `rankableCount` 与对应节点榜（同一过滤片段、同快照）的行数
- **那么** 二者**必须**逐节点相等（含 root / 父 / 叶 / 酒类=0），由共用过滤片段 + `unit_price` 1:1 保证

#### 场景:未 seed 时返回空节点集

- **当** `tag` 表无任何 kind=category 行
- **那么** 查询**必须**返回空节点集，**禁止**报错

