# api-client 规范

## 目的
待定 - 由变更 add-miniapp-skeleton 创建。归档后请更新目的。

`packages/api-client`（`@unit-price/api-client`）是四个客户端与 `apps/api` 共享的 API 契约包，传输无关——只导出 schema/类型与纯函数（`buildRankingsUrl` / `parseRankingsResponse`），不含任何网络调用。本期承载 `/rankings` 契约，`RankingsResponseSchema` 为契约单一事实源、由 app 与客户端共依赖同一份。
## 需求
### 需求:api-client 必须提供传输无关的 rankings 契约

`packages/api-client`（`@unit-price/api-client`）**必须**作为四个客户端与 `apps/api` 共享的 API 契约包，本期承载 `/rankings` 契约。它**必须传输无关**——**禁止**包含任何网络调用（`fetch`/`Taro.request`/`wx.request` 等），发请求由各客户端自理。本包导出：

- `RankingsResponseSchema`（Zod）+ 推导类型 `RankingsItem` / `RankingsResponse`——**契约单一事实源**，由 `apps/api` 与客户端**共依赖同一份**；字段集与 `rankings-api` 契约一致（`rank/title/priceCents/per100ml/formula/confidence/warnings/store/storeSku/sourceUrl/capturedAt/lowestPriceCents`），`warnings` 复用 `@unit-price/core` 的 `WarningsSchema`（不另写重复定义）；`capturedAt`（整数 epoch ms）与 `lowestPriceCents`（整数分）**设 `.optional()`**——服务端在线响应恒发二字段，`.optional()` 只为让共依赖同一 schema 的**独立发布客户端**容忍跨版本旧服务端与 **CDN 24h 缓存旧响应**（缺字段仍解析通过、不 ZodError 整屏错）;设必填会在每次改 schema 的部署后制造最长 24h 的整屏错窗口。该 schema 由 `/compute` 的 `ComputeResultSchema` 按引用复用（`neighbors: RankingsItem[]`），故两字段的可选性对 compute 邻居行一致生效。
- `buildRankingsUrl(base, { limit?, offset?, category? })`：**纯 URL 序列化函数**，不发请求、**不校验参数值**（值合法性由服务端按 `rankings-api`「分页与查询参数边界」需求做 `400` 兜底——本函数只序列化、不重复校验，分工明确）。语义**必须**钉死：`base` **必须恰为规范 `http(s)` origin**——即 `base`（去除一个可选末尾斜杠后）**严格等于**其解析出的 `origin`（`scheme://host[:port]`，小写 host、省略默认端口、无 path/query/fragment/userinfo）。凡**非规范形态**（含 path/`?`/`#`/userinfo、空串、非 `http(s)` scheme、**缺 `//`** 如 `https:host`、**dot-segment** 如 `https://host/.`、大写 host、显式默认端口等）一律视为配置误用、**必须抛错**（fail-fast、不静默规范化——base 是受控配置常量，非规范值是配置错误而非待归一输入）。通过后以 `<origin>/rankings` 为根、以 `?k=v&...` 拼入**仅已给**的参数；参数值**必须**经 `encodeURIComponent` 编码；全缺省 `{}` 时返回 `<origin>/rankings`（无 `?` 串）。
- `parseRankingsResponse(json: unknown): RankingsResponse`：用 `RankingsResponseSchema` 的 `.parse(json, { jitless: true })` 校验。校验失败**必须抛出 `ZodError`（原样冒泡、不吞不包装）**（fail-closed），**禁止**返回未校验/部分数据——调用方把**任意抛出**当作错误态处理（不依赖具体错误 shape、catch 到即走错误态）。**必须传 `jitless: true`**：本包传输无关、须在**禁 `eval`/`new Function` 的运行时**（微信小程序等）可跑，而 Zod 4 object schema 默认 JIT 用 `new Function` 编解析器——per-parse `jitless` 跳过 JIT、走解释执行（语义不变；ctx 下传至嵌套 schema；对 Node/Workers 无害，Workers 本就禁 eval、Zod 探针自动降级）。

本包**必须**只依赖 `@unit-price/core`（领域类型/`WarningsSchema`）+ Zod，**禁止**依赖任何运行时/框架包（Taro、apps/api 等）。`RankingsResponseSchema` 由本包**定义**（从 `apps/api/src/routes.ts` 迁入），`apps/api` 改为从本包 import（不再自持定义）。

#### 场景:契约由 api-client 单一事实源、api 与客户端共依赖

- **当** 检查 `RankingsResponseSchema` 的定义位置
- **那么** 它**必须**定义在 `packages/api-client`（非 `apps/api/src/routes.ts`），`apps/api` 与小程序均从 `@unit-price/api-client` import 同一份；字段集与 `warnings`（复用 core `WarningsSchema`）与既有 rankings-api 契约逐一一致

#### 场景:RankingsItem 的 capturedAt 与 lowestPriceCents 为可选字段

- **当** 用 `RankingsResponseSchema` 解析一项**缺** `capturedAt` 或 `lowestPriceCents` 的对象（跨版本旧服务端 / CDN 旧缓存响应）
- **那么** 校验**必须通过**（二者 `.optional()`），推导类型中二字段为 `number | undefined`
- **当** 解析一项**含** `capturedAt`/`lowestPriceCents` 的对象、但其值不是整数（如字符串、小数）
- **那么** 校验**必须**失败（存在即须为整数：`capturedAt` epoch ms、`lowestPriceCents` 分）

#### 场景:传输无关——不含网络调用

- **当** 检查 `packages/api-client` 的源码与依赖
- **那么** **禁止**出现 `fetch`/`Taro.request`/`wx.request` 等网络调用或对运行时/框架包的依赖；只导出 schema/类型/`buildRankingsUrl`/`parseRankingsResponse`，发请求留各客户端

#### 场景:buildRankingsUrl 只拼已给参数

- **当** 调用 `buildRankingsUrl("https://api.example.com", { limit: 50, offset: 100 })`（未给 `category`）
- **那么** **必须**返回 `https://api.example.com/rankings?limit=50&offset=100`、**不含** `category`；只拼入已给的参数

#### 场景:buildRankingsUrl 规整 base 末尾斜杠与全缺省

- **当** 调用 `buildRankingsUrl("https://api.example.com/", {})`（base 带末尾斜杠、无参数）
- **那么** **必须**返回 `https://api.example.com/rankings`（去重复斜杠、无 `?` 串）

#### 场景:buildRankingsUrl 对非规范 origin 的 base fail-fast

- **当** 调用 `buildRankingsUrl` 时 `base` 非规范——含 path（`https://x/v1`）、query（`https://x?a=1`）、fragment（`https://x#f`）、userinfo（`https://u:p@x`）、缺 `//`（`https:x`）、dot-segment（`https://x/.`）、显式默认端口（`https://x:443`）或非 `http(s)`（`ftp://x`）/空串
- **那么** **必须抛错**（配置错误 fail-fast），**禁止**静默产出坏 URL 或把非规范输入**静默规范化**当作合法配置（如 `https:x`→`https://x/rankings`、`https://x/.`→`https://x/rankings` 都应抛而非接受）

#### 场景:buildRankingsUrl 不校验参数值、只序列化

- **当** 传入服务端会判 `400` 的值（如 `{ limit: 0 }`、`{ category: "alcohol" }`）
- **那么** `buildRankingsUrl` **必须**照常把值序列化进 URL（如 `?limit=0`、`?category=alcohol`），**不抛错、不静默改值**——值合法性留给服务端按 `rankings-api` 查询边界需求做 `400`

#### 场景:parseRankingsResponse 校验失败抛 ZodError fail-closed

- **当** `parseRankingsResponse` 收到不满足 `RankingsResponseSchema` 的 JSON（如 `warnings` 非 `string[]`、缺字段）
- **那么** **必须抛出 `ZodError`**（原样冒泡），**禁止**返回未校验或部分数据；调用方 catch 到任意抛出即走错误态

#### 场景:apps/api 复用同一契约且行为不变

- **当** `apps/api` 改为从 `@unit-price/api-client` import `RankingsResponseSchema`（`routes.ts` handler 与 `index.ts` re-export 改 import 源）
- **那么** `/rankings` 的响应字段、错误码、治理豁免**均不变**；回归由 `apps/api` 既有 **`/rankings` 行为测试**（`routes.test.ts` 的 rankings 用例）保证仍绿（这些测试经 `createApp` 验端到端行为、不直接 import 该 schema，故迁移是纯重构、行为测试是回归基准）

### 需求:api-client 必须提供传输无关的 categories 契约

`packages/api-client`（`@unit-price/api-client`）**必须**新增 `GET /categories`（品类树浏览）的共享契约，与既有 rankings 契约**同样传输无关**——**禁止**包含任何网络调用（`fetch`/`Taro.request`/`wx.request` 等），发请求由各客户端自理。本契约与 rankings 契约**形态对齐**（同一包内一致的 schema + 纯 URL 序列化 + fail-closed 校验三件套），由 `apps/api` 与客户端（小程序等）**共依赖同一份**。本包**必须**新增导出：

- `CategoryTreeResponseSchema`（Zod）+ 推导类型——**契约单一事实源**，字段集与 `category-tree-api` 契约一致：`{ nodes: { slug, name, parentSlug(nullable), comparableUnit(nullable), rankable(boolean), rankableCount(int>=0) }[] }`。**禁止**在 `apps/api/src/routes.ts` 手写重复类型。
- `buildCategoriesUrl(base)`：**纯 URL 序列化函数**，不发请求。**必须**复用 `buildRankingsUrl` 同款 clean-origin fail-fast 校验（`base` 须恰为规范 `http(s)` origin，非规范形态——含 path/`?`/`#`/userinfo、空串、非 `http(s)`、缺 `//`、dot-segment、大写 host、显式默认端口等——**必须抛错**、不静默规范化）；通过后返回 `<origin>/categories`。`/categories` 本期**无查询参数**，故无参数序列化分支。
- `parseCategoryTreeResponse(json: unknown): CategoryTreeResponse`：**必须与既有 `parseRankingsResponse(json)` 签名形态一致**——**只接 `json` 一个入参、内部硬编码 `{ jitless: true }`**（`CategoryTreeResponseSchema.parse(json, { jitless: true })`），**禁止**把 `jitless` 暴露成调用方可选项（避免调用方漏传致 weapp `new Function`/eval 禁用下 JIT 解析崩溃——与 `parseRankingsResponse` 同样的运行时约束与已知坑）。校验失败**必须**抛 `ZodError`（原样冒泡、fail-closed），**禁止**返回未校验/部分数据。

**禁止**新增任何会发 HTTP 的方法（如 `getCategories()`）——那会破坏本包传输无关契约；URL 构造与响应校验分离、发请求留各客户端（miniapp `Taro.request`、web/插件 `fetch`），与既有 rankings 契约同构。

#### 场景:导出传输无关的 categories 契约三件套

- **当** 检查 `@unit-price/api-client` 的导出
- **那么** **必须**含 `CategoryTreeResponseSchema` + 推导类型、`buildCategoriesUrl`、`parseCategoryTreeResponse`；**禁止**出现 `fetch`/`Taro.request`/`wx.request` 等网络调用或会发请求的 `getCategories()`；`apps/api` 与小程序均从本包 import 同一份 schema

#### 场景:buildCategoriesUrl 规范 origin 产 /categories、非规范 fail-fast

- **当** 调用 `buildCategoriesUrl("https://api.example.com")` 与 `buildCategoriesUrl("https://api.example.com/")`
- **那么** 两者**必须**返回 `https://api.example.com/categories`（去重复末尾斜杠、无 `?` 串）；`base` 非规范（含 path/query/fragment/userinfo、缺 `//`、空串、非 `http(s)` 等）时**必须抛错**，与 `buildRankingsUrl` 同口径

#### 场景:parseCategoryTreeResponse 签名对齐 sibling、jitless 内置、fail-closed

- **当** 检查 `parseCategoryTreeResponse` 的签名与实现
- **那么** 它**必须**只接 `json` 一个入参、内部以 `{ jitless: true }` 调 `CategoryTreeResponseSchema.parse`（与 `parseRankingsResponse` 形态一致、不把 jitless 外露）；收到不满足 schema 的 JSON（缺字段、`rankableCount` 非整、`nodes` 非数组等）时**必须**抛 `ZodError`（fail-closed），**禁止**返回未校验/部分数据

