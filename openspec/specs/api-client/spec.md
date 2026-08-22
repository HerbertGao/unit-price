# api-client 规范

## 目的

`packages/api-client`（`@unit-price/api-client`）提供服务端与薄客户端共享的传输无关契约：Zod schema、推导类型、纯 URL 构造和响应解析，以及从全量榜单快照派生 cohort、搜索与分页的纯函数。它不发网络请求，并作为 `/rankings`、`/categories`、`/compute` 契约的单一事实源。

## 需求

### 需求:api-client 必须提供传输无关的 rankings 契约

`packages/api-client` 是各客户端与 `apps/api` 共享的契约包,承载 `/rankings` 契约。传输无关:不含 `fetch`/`Taro.request`/`wx.request`,发请求由各客户端自理。

`/rankings` 改为全量快照后,本契约随之改形:

- **`RankingsSnapshotSchema`** —— 契约单一事实源。响应是对象,含 `rows` / `categoryNodes` / `excluded`,字段与 `rankings-api` 的快照字段表一一对应,不多不少。
- **一个品类节点形状**:`CategoryTreeResponseSchema.nodes` 与 `RankingsSnapshotSchema.categoryNodes` 必须直接复用同一节点 schema,字段恰为 `slug` / `name` / `parentSlug` / `comparableUnit` / `rankable`,不定义 `rankableCount`。
- **健康信号不得否决载荷**:`excluded[].reason` 在 wire schema 中只要求非空字符串,不得收窄为枚举。生产者可用类型约束防止拼写错误,但新增 reason 不得让旧客户端把整份快照判坏。
- **三个行形状**:`RankingsItemSchema`(既有,**不改动**——`/compute` 的 `neighbors` 按引用复用它,放松其 `rank` 会连带松掉 compute 邻居行的保证);**快照行** = `RankingsItemSchema.omit({ rank: true })` 追加 `id` / `categorySlugs`;**视图行** = 快照行 `.extend({ rank })`,由本包派生能力在切片时产出。
- **`categorySlugs`(非空数组)与 `id`(非空)必填**。与 `capturedAt`/`lowestPriceCents` 的可选性理由相反:后者缺失只少显示一个信息;缺 `categorySlugs` 的行能通过校验、然后在每个品类视图里被静默漏掉。`id` 只约束非空,**不约束值域格式**——`unit_price.id` 允许 UUID 或 ULID,且它不参与比较。
- **没有排序键**。客户端不排序:过滤与切片保序,派生视图继承服务端下发的序。故契约里不存在「客户端据以复现全序」的字段,也不存在跨引擎比较口径要对齐的问题。
- **`buildRankingsUrl(base)`** —— 只接 `base`,返回 `<origin>/rankings`。不保留查询参数入参:留着会让调用方以为服务端仍支持过滤。`base` 的规范 origin 校验与 fail-fast 语义不变。
- **`parseRankingsSnapshot(json)`** —— 只接一参,内部写死 `{ jitless: true }`(外露会在禁 `eval` 的运行时因 JIT 崩溃),失败抛 `ZodError` 原样冒泡。

**对象级不变量必须在解析时校验**,仅校验字段结构不够——下列任一不成立都会让派生结果静默错误而非报错:`categoryNodes` 的 slug 唯一;非空 `parentSlug` 指向存在的节点;`parentSlug` 链无环(否则祖先推导会死循环);每行 `categorySlugs` 均在 `categoryNodes` 中(否则该行在每个视图里被静默漏掉,却仍计入整体)。

**不校验 `rows` 的序**:序由服务端下发、客户端继承,派生不重排,故「乱序」在本契约内不是可判定的缺陷,加一条永远为真的断言只会让读者以为客户端在依赖它。

**空 taxonomy 是合法态**:`categoryNodes` 为空时 `rows` 亦为空,必须校验通过并由调用方渲染空态。

本包只依赖 `@unit-price/core`(领域类型 / `WarningsSchema` / `ComparableUnitSchema`)+ Zod,不依赖任何运行时 / 框架包。

#### 场景:契约由 api-client 单一事实源、api 与客户端共依赖

- **当** 检查快照 schema 的定义位置
- **那么** 必须定义在 `packages/api-client`,`apps/api` 与客户端 import 同一份;`warnings` 复用 core 的 `WarningsSchema`,`categoryNodes` 与 `CategoryTreeResponseSchema.nodes` 直接复用同一份无计数节点 schema

#### 场景:品类树与快照节点契约完全同形

- **当** 分别解析 `GET /categories` 响应的 `nodes` 与 `/rankings.categoryNodes`
- **那么** 两者必须使用同一节点 schema,字段中不得定义 `rankableCount`

#### 场景:新增健康信号不使旧客户端拒绝整份快照

- **当** `excluded[].reason` 出现生产者新增的非空值
- **那么** wire 校验必须通过;客户端可忽略不认识的 reason,不得因此拒绝 `rows` 与 `categoryNodes`
- **当** reason 为空字符串或不是字符串
- **那么** wire 校验必须失败

#### 场景:RankingsItem 的 capturedAt 与 lowestPriceCents 为可选字段

- **当** 解析一行缺 `capturedAt` 或 `lowestPriceCents` 的快照行
- **那么** 校验通过,推导类型中二者为 `number | undefined`
- **当** 二者存在但不是整数
- **那么** 校验失败

#### 场景:传输无关——不含网络调用

- **当** 检查 `packages/api-client` 的源码与依赖
- **那么** 不得出现网络调用或对运行时 / 框架包的依赖

#### 场景:buildRankingsUrl 只拼已给参数

- **当** 调用 `buildRankingsUrl(base)`
- **那么** 返回不带 `?` 串的 `<origin>/rankings`;函数不得再接受任何查询参数入参

#### 场景:buildRankingsUrl 规整 base 末尾斜杠与全缺省

- **当** 调用 `buildRankingsUrl("https://api.example.com/")`
- **那么** 返回 `https://api.example.com/rankings`

#### 场景:buildRankingsUrl 对非规范 origin 的 base fail-fast

- **当** `base` 含 path / query / fragment / userinfo,或缺 `//`、含 dot-segment、显式默认端口、非 `http(s)`、空串
- **那么** 必须抛错,不得静默产出坏 URL 或静默规范化

#### 场景:buildRankingsUrl 不校验参数值、只序列化

- **当** 调用方试图传入查询参数
- **那么** 该入参面必须已不存在(编译期不可传);原「值合法性留服务端 400」的分工随参数一并消失

#### 场景:parseRankingsResponse 校验失败抛 ZodError fail-closed

- **当** 快照解析函数收到不满足 schema 的 JSON(缺 `categorySlugs`、`rows` 非数组、`categoryNodes` 缺字段等)
- **那么** 必须抛 `ZodError` 原样冒泡,不得返回未校验或部分数据
- **那么** 该函数名为 `parseRankingsSnapshot`;`parseRankingsResponse` 随旧数组形状一并移除

#### 场景:apps/api 复用同一契约且行为不变

- **当** `apps/api` 从本包 import 快照 schema
- **那么** 契约只有一份定义;治理豁免与缓存头口径不变
- **那么** 因本变更蓄意改变了响应形状,`apps/api` 既有的 `/rankings` 行为测试必然失败并必须改写到新契约

#### 场景:对象级不变量必须被校验

- **当** 解析一份快照
- **那么** 必须校验:`categoryNodes` slug 唯一、非空 `parentSlug` 指向存在节点、`parentSlug` 链无环、每行 `categorySlugs` 均在 `categoryNodes` 中
- **那么** 任一不成立必须抛 `ZodError`——它们不成立时派生结果会静默错误(漏行、遍历崩),而字段结构校验一概放行
- **那么** **不得**校验 `rows` 的序:客户端不排序、继承服务端的序,该断言永远为真且会误导读者
- **当** 快照为 `{ rows: [], categoryNodes: [], excluded: [] }`
- **那么** 必须校验通过并渲染空态,不得判为损坏

### 需求:api-client 必须提供传输无关的 categories 契约

`packages/api-client`(`@unit-price/api-client`)必须提供 `GET /categories` 的共享传输无关契约,由 `apps/api` 与客户端依赖同一份 schema。禁止包含 `fetch` / `Taro.request` / `wx.request` 等网络调用;发请求由客户端自理。本包必须导出:

- `CategoryTreeNodeSchema` / `CategoryTreeResponseSchema` 及推导类型。节点字段恰为 `slug` / `name` / `parentSlug`(可空) / `comparableUnit`(可空) / `rankable`;不得定义 `rankableCount`。`RankingsSnapshotSchema.categoryNodes` 必须直接复用同一节点 schema。
- `buildCategoriesUrl(base)`:复用 rankings URL 构造的规范 origin fail-fast 规则,返回 `<origin>/categories`,不发请求。
- `parseCategoryTreeResponse(json)`:单参数、内部固定 `{ jitless: true }`,失败抛原始 `ZodError`,不得返回未校验或部分数据。

本契约不得新增会发 HTTP 的 helper;URL 构造、请求发送与响应校验保持分离。

#### 场景:导出传输无关的 categories 契约三件套

- **当** 检查 `@unit-price/api-client` 的导出与依赖
- **那么** 必须含共享 categories schema/类型、`buildCategoriesUrl`、`parseCategoryTreeResponse`,且不得含网络调用
- **那么** categories 与 snapshot 必须直接复用同一无 `rankableCount` 节点 schema

#### 场景:buildCategoriesUrl 规范 origin 产 /categories、非规范 fail-fast

- **当** 调用 `buildCategoriesUrl("https://api.example.com")` 或带一个末尾斜杠的等价规范 origin
- **那么** 返回 `https://api.example.com/categories`
- **当** base 含 path/query/fragment/userinfo、缺 `//`、为空、非 http(s)、含 dot-segment、大写 host 或显式默认端口
- **那么** 必须抛错,不得静默规范化

#### 场景:parseCategoryTreeResponse 签名对齐 sibling、jitless 内置、fail-closed

- **当** 调用 `parseCategoryTreeResponse` 解析满足共享节点 schema 的对象或 `{ nodes: [] }`
- **那么** 返回已校验数据,且节点不暴露 `rankableCount`
- **当** 节点缺必填字段、字段类型错误或 `nodes` 非数组
- **那么** 必须抛 `ZodError`;调用方不可关闭 jitless 或取得部分数据

### 需求:api-client 必须提供从榜单快照派生视图的能力

`packages/api-client` 必须提供从一份快照派生各视图的能力——按 cohort 过滤、分页、按商品名子串搜索——使调用方不必自行实现这些口径。

**全量是传输单位,cohort 是展示单位**:本包产出的任何视图必须限定在单一可比口径内,不得提供「不限定 cohort 的全量榜」视图。

- **不提供排序**:服务端按 `(per100ml, unit_price.id)` 升序下发,过滤与切片保序,派生视图继承该序。本包不得含排序能力——提供它等于允许调用方产出与服务端不同的序,而两个序之间没有仲裁者。
- **落地 cohort 不由本包决定**:派生入口必须显式收 cohort slug。「最浅的单一可比轴节点」看似可从树推导、实则不唯一(`soft-drink` 与 `dairy` 同为 root 直子且同为 `per_100ml`),任何平局判据都是树不承载的额外规则;由消费端按自己的落地语义指定(见 `miniapp`)。
- **cohort 过滤**:沿快照 `categoryNodes` 的 `parentSlug` 推导祖先,判据是该行 `categorySlugs` 中**任一**是目标节点的后代(含自身)。判定所用的树必须取自**同一份快照**。判据对叶与非叶一致成立——非叶挂载来自 taxonomy 演化,那些行仍在售,不得因此被剔除。
- **两条拒绝分支**,缺一则「与服务端同口径」不成立:
  - 目标节点 `comparableUnit` 为 `null` → 拒绝并给出可呈现原因;
  - 目标 slug **不在** `categoryNodes` 中(未播种 / 已下架 / 陈旧快照)→ 返回**可与上一条区分**的拒绝态,与服务端「未知品类」同口径。
- **搜索**:在当前 cohort 内筛选。口径:`trim` → **有效码点数 < 2 判为无效词** → 按 Unicode 码点截断 ≤64 → 仅 `A-Z`↔`a-z` 折叠 → 子串。不得用 `toLowerCase()`(它折叠 Unicode)、不做全角半角归一;`%` / `_` / `!` 按字面量(本地无 `LIKE`)。
- **无效词必须可与「未搜索」区分**:归一化对无效词产出一个**与「调用方没给词」不同**的结果,使调用方能匹配空集而非落回不过滤。≥2 码点门存在的理由是「单个汉字命中目录里绝大多数」;若无效词落回不过滤,它命中的是**全部**,恰好是该门要防的极端。
- **分页**:对已过滤结果切片,按 `offset + 1-based index` 赋 `rank` 产出视图行,并对越界的 `offset` / `limit` 抛错而非静默产出坏 `rank`。本地切片不会失败,调用方不得为其保留网络翻页的错误态。

**与服务端 cohort 判定的关系**:客户端依据快照里 DB-seed 解析后的 `comparableUnit`,服务端依据编译期静态解析。二者在 taxonomy 已播种后相等;未播种窗口 `categoryNodes` 为空,由上面第二条分支处理。客户端判定是前置拦截,服务端权威守卫不因此撤除。

#### 场景:任何视图都限定在单一 cohort 内

- **当** 调用方派生视图
- **那么** 必须显式给出 cohort slug;本包不得提供跨 cohort 的全量混排视图,也不得代调用方猜一个落地 slug

#### 场景:按祖先节点过滤得到全部后代

- **当** 以一个非叶但单一可比口径的 slug 过滤
- **那么** 结果必须含其全部后代叶的行

#### 场景:非叶挂载的行仍在该节点视图内

- **当** 某行的 `categorySlugs` 含一个**非叶**节点(taxonomy 演化留下的历史挂载)
- **那么** 该行必须出现在该节点及其祖先的视图里;不得因「挂载点不是叶」而被剔除
- **那么** 它不得出现在它从未挂过的兄弟叶的视图里

#### 场景:双叶行在单个视图内只出现一次、且两个视图都能看到它

- **当** 某行 `categorySlugs` 含两个分属不同祖先的叶
- **那么** 在任一祖先的视图里出现且只出现一次;在另一个祖先的视图里也必须出现

#### 场景:两条拒绝分支必须可区分

- **当** 目标节点在 `categoryNodes` 中存在但 `comparableUnit` 为 `null`
- **那么** 拒绝并给出可呈现原因,不得混排不同轴
- **当** 目标 slug 不在 `categoryNodes` 中
- **那么** 返回与上一条**不同**的拒绝态,与服务端「未知品类」同口径

#### 场景:端上继承服务端的序、既不排序也不重算单价

- **当** 派生任意视图
- **那么** 行序必须与服务端下发顺序一致;本包不得提供排序能力,也不得重算 `per100ml`
- **当** 两行 `per100ml` 相等
- **那么** 其先后由服务端下发顺序决定,客户端不得干预

#### 场景:本地搜索口径为 ASCII-only 折叠

- **当** 搜索词 `cola`,cohort 内有 `Coca Cola` 与 `COCA COLA`
- **那么** 二者都命中
- **当** 搜索词 `café`,cohort 内有 `Café` 与 `CAFÉ`
- **那么** 只命中 `Café`,不得命中 `CAFÉ`
- **当** 搜索词含 `%` / `_` / `!` 或全角字符
- **那么** 按字面量匹配,不做通配解释或全角半角归一
- **当** 搜索词 `trim` 后有效码点数 < 2
- **那么** 必须判为无效词,且该结果必须与「调用方未给词」可区分——否则调用方只能落回不过滤,而那会端出整个 cohort

#### 场景:搜索限定在当前 cohort 内

- **当** 用户在某 cohort 的榜内搜索
- **那么** 命中集合限定在该 cohort 内

#### 场景:分页切片不产生失败态

- **当** 取下一页
- **那么** 纯本地操作、不发请求、不产生失败;`rank` 按 `offset + 1-based index` 赋值;切片耗尽即到底
- **当** `offset` 为负或 `limit` < 1
- **那么** 必须抛错——那是调用方的编程错误,静默切出 `rank: 0` 会让错值流进渲染
