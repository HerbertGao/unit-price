# rankings-api 规范

## 目的

`GET /rankings` 是只读、治理豁免的全量榜单快照接口，一次返回已落库的可比单价行、同版本品类树和排除健康信号。服务端按真实单价确定全序且不重算；客户端从该快照本地派生单一 cohort 榜、搜索和分页。

## 需求

### 需求:GET /rankings 只读榜单接口

`apps/api` 必须提供 `GET /rankings`,一次返回全部可比行与判定其归属所需的品类树,作为单一可缓存对象。只读:不写库、不调 LLM、不触发后台任务、不出站 fetch。

**不接受参数**:`category` / `q` / `limit` / `offset` 移除。带上任一参数时必须被忽略,响应与无参请求逐字相同——否则响应随参数分叉成多个缓存对象,而单一缓存键是本接口存在的理由。

**响应形状**:对象 `{ rows, categoryNodes, excluded }`。

- `categoryNodes` 是全部 `kind=category` 节点(`slug`/`name`/`parentSlug`/`comparableUnit`/`rankable`),继承解析在内存完成。该节点数组与 `GET /categories` 响应的 `nodes` 逐字同形,两者均不带 `rankableCount`;客户端需要数量时从快照派生。
- `excluded` 是被排除行或节点的 `{ reason, count }`,数据健康观测项,不作为失败判据。wire 侧 `reason` 只要求非空字符串,不得用封闭枚举让新增健康信号否决整份载荷。
- **落地 cohort 不由服务端下发**:多发一个 slug 只会多一处要保持同步的地方。它也**不可从 `categoryNodes` 推导**——「最浅的单一可比轴节点」无唯一解(`soft-drink` 与 `dairy` 同深同轴),由消费端以具名常量承载,见 `miniapp` spec。

**入榜两门**:`product.rankable = true` ∧ `unit_price.per100ml IS NOT NULL`。

**没有叶性门。** `attachTag` 已在写入侧强制叶粒度(非叶挂载直接抛),故唯一能产生非叶挂载的是 **taxonomy 演化**——一个叶后来长出子节点。那些商品仍在售,把它们剔除等于在一次 taxonomy 编辑里静默丢掉在售行。归属由 `categorySlugs` 承载,判据是「任一 slug 是目标节点或其后代」,对叶与非叶一致成立。

**行字段**:`title` / `priceCents` / `per100ml` / `formula` / `confidence` / `warnings` / `store` / `storeSku` / `sourceUrl` / `capturedAt` / `lowestPriceCents`,并新增:

- `categorySlugs: string[]`(非空,升序)—— 该行挂的**全部** category slug。数组而非单值:单归属由应用层写时维护、非 DB 约束,双叶行可达;单值会导致重复入榜或丢失另一榜的归属。
- `id: string` —— 承载 `unit_price.id`,作**稳定行身份**供客户端做列表 key(`rank` 每次换 cohort/搜索都变,用它入 key 会让整列表 remount)。**不是排序键**:客户端不排序,派生视图继承服务端下发的序,故不存在跨引擎比较口径要对齐。

`rank` 移出行契约:它是某个过滤+排序视图下的读时位次,在无参全量集合里无定义,由客户端派生视图时赋值。

**每行恰一行**:按 `unit_price.id` 聚合其全部 category slug。发两行会使客户端派生的榜重复入榜、名次重复。

**下发顺序**:按 `(per100ml, unit_price.id)` 升序,使服务端全序有可直接比对的地面真相。

**单个行或节点的字段缺陷不得打掉整份快照**:快照是唯一数据源,一个坏成员不应使榜单、分类树、搜索、比价定位同时不可用。故不满足行必填字段的行计入 `row_shape_invalid`;不满足节点 schema 的节点计入 `node_shape_invalid`;自身形状合法但引用被排除节点的行计入 `row_references_invalid_node`。生产者 reason 使用受类型约束的词表防止拼写错误,但 wire schema 只要求非空字符串,新增 reason 不得使旧客户端拒绝载荷。

**装配一致性**:行、归属边、taxonomy 节点是三次读,其间的并发写会装配出「行引用了 `categoryNodes` 中不存在的节点」的对象并被缓存最长一个 TTL。三者互不依赖,故可一次性发出(D1 用 `batch()`——它拒绝显式 BEGIN/COMMIT;sqlite 用事务)。可恢复的单成员字段缺陷先按上文排除;准入后若仍违反对象级不变量(节点 slug 重复、父链悬空/成环、行引用未知节点),必须按服务端缺陷处理并返回 5xx,同时记录带校验上下文的错误日志。

**未播种 taxonomy**:`categoryNodes` 为空是合法退化态,此时 rows 亦为空,必须返回 `200` 的空快照。

**缓存与治理**:`Cache-Control` 沿用 `PUBLIC_CACHE_CONTROL`;治理豁免不变(不消耗公共限频、不记 usage)。

**`lowestPriceCents` 的取值规则**:必须为 `COALESCE(lowest_price, price)`,**禁止**透出 `NULL`——存量偶有空水位或仅异常价历史时退化为当前价。客户端仅当 `priceCents > lowestPriceCents` 才呈现「历史低」,故退化(二者相等)时不呈现,异常价也不会被当作历史低。该规则原挂在 `persistence` 里对已删的 `listRankings` 投影的描述上;本查询接手后规则本身不变,只是换了承载者。

**口径漂移与 warnings 透出**:`priceCents`(整件总价分)与 `per100ml`(按总容量摊算)分母不同、前端禁互推、可比量一律用 `per100ml`。二者同源于最近一次成功解析,但**仍存在四类窗口**,且**不都会自动自愈**——**禁止**把它们写成瞬时或封闭的集合:① 边缘/端上缓存 TTL 内的旧 JSON(自愈:TTL 到期或 purge);② `/ingest` 落地顺序与后台解析完成顺序可逆,迟到的解析会让派生值短暂落后(自愈);③ `product_raw` 已落地而其解析未完成或**失败**(后台失败只记日志、不重试,**不自愈**;收敛动作是再重报一次且解析出等价 `ParsedSpec`);④ 解析结果漂移产生新 `product` 行后旧行不再被任何 `saveParsed` 命中,派生值停在旧价(**不自愈**,已知非目标、无收敛动作)。读路径**仍禁止**为消除窗口而重算 `per100ml`。

**`formula` 内嵌元价与 `priceCents` 的口径差 ≤1 分**(元价允许多于两位小数、`product_raw.price` 存 `Math.round`):核对**必须**按分比较(`yuanToCents(parseFloat(首项)) === priceCents`),**禁止**把严格相等当作契约、亦**禁止**用浮点容差——浮点容差会把真正过期一分钱的行判绿。

**数据源与留痕**:`per100ml`/`formula`/`confidence`/`warnings` 取 `unit_price` 存储列,读路径不重算;`packages/core` 不进读路径。失效判定与历史低价的呈现条件在客户端,服务端只透出 `capturedAt`/`lowestPriceCents`,不下发随时间衰减的布尔。

#### 场景:无参默认 ≡ category=soft-drink（默认榜节点 root→软饮）

- **当** 客户端 `GET /rankings`
- **那么** 必须返回全量快照;原「无参 ≡ soft-drink」的语义改由客户端以具名落地常量承载(见 `miniapp` spec),用户所见落地榜与改造前一致。**不得**改由从树上推导——那无唯一解,且实测会落到另一个 cohort
- **当** 请求带 `category` / `q` / `limit` / `offset`
- **那么** 该参数必须被忽略,响应与无参请求逐字相同

#### 场景:各酒种叶有自己的 per100ml cohort 榜

- **当** 客户端需要某酒种叶的榜
- **那么** 由客户端在快照上按该叶过滤得出;各酒种是独立 cohort,不得并入同一个呈现给用户的榜;这些行必须在快照内

#### 场景:乳品有自己的 per100ml cohort 榜

- **当** 客户端需要乳品的榜
- **那么** 同上,由客户端按乳品节点过滤得出,不含软饮 / 酒类

#### 场景:跨 cohort 节点（酒类父 / root 饮料）拒绝开榜

- **当** 目标节点 `comparableUnit` 为 `null`(`alcohol` / `beverage`)
- **那么** 客户端派生视图必须拒绝该节点,不得呈现跨 cohort 混榜
- **那么** 服务端不得因此把这些行排除出快照——快照是传输单位,拒绝发生在展示层

#### 场景:per100ml 为 null 的项不入榜

- **当** 某 rankable 商品 `per100ml = null`
- **那么** 该行不得出现

#### 场景:违反单归属（同商品双叶）时仍至多列一次（DISTINCT 兜底）

- **当** 某商品挂两条 category 叶边
- **那么** 快照中必须恰有一行,其 `categorySlugs` 同时含两个 slug

#### 场景:formula/per100ml 取存储值不重算

- **当** 某项落库 `formula = "40 / (330 * 24 * 1) * 100"`、`per100ml ≈ 0.505`
- **那么** 响应中二者等于存储值,不得用 `priceCents` 重算覆盖

#### 场景:单件推断项带 warning 入榜而非被剔除

- **当** 某入榜项 `warnings` 含「数量按单件推断为 1」
- **那么** 照常入榜、原样透出

#### 场景:响应每项透出 capturedAt 与 lowestPriceCents

- **当** 某行 `captured_at = 1_700_000_000_000`、`price = 1490`、`lowest_price = 990`
- **那么** 该项含 `capturedAt = 1_700_000_000_000` 与 `lowestPriceCents = 990`;`priceCents` 仍为 `1490`

#### 场景:失效项仍入榜、服务端不判失效

- **当** 某入榜行 `captured_at` 早于当前 30 天以上
- **那么** 照常出现在快照内;响应不得含服务端 `stale` 布尔;失效判定由客户端按 `now - capturedAt > 阈值` 完成

#### 场景:历史低价仅透出、呈现条件在客户端

- **当** 某行 `priceCents = 990`、`lowestPriceCents = 990`
- **那么** 服务端照常透出二字段;是否呈现「历史低」由客户端判定

#### 场景:全序可复现且不合规行被排除而非致命

- **当** 两行 `per100ml` 相等
- **那么** 下发顺序由 `unit_price.id` 升序决定;客户端**不重排**——过滤与切片保序,派生视图继承该序,故不存在跨引擎比较口径要对齐
- **当** 某行不满足两门或行不变量
- **那么** 该行被排除、计入可观测的排除计数,响应照常成功

#### 场景:无效节点按 reason 排除而非打掉整份快照

- **当** 某 category 节点不满足节点 schema
- **那么** 该节点计入 `node_shape_invalid`;引用它且自身形状合法的行计入 `row_references_invalid_node`,其余快照照常返回

#### 场景:新增 exclusion reason 不否决载荷

- **当** 服务端生产一个旧客户端未见过的非空 `excluded[].reason`
- **那么** 快照 wire 校验必须通过,健康信号不得使 `rows` 与 `categoryNodes` 一并不可用

#### 场景:对象级断言失败返回 5xx 且记录日志

- **当** 单成员准入后仍存在节点 slug 重复、父链悬空/成环或行引用未知节点
- **那么** 必须返回 5xx 并记录错误日志,不得静默下发错误快照

#### 场景:未播种 taxonomy 返回空快照而非失败

- **当** taxonomy 未播种(`categoryNodes` 为空)
- **那么** 必须返回 `200` 的空快照(`rows` 亦为空);不得 5xx
