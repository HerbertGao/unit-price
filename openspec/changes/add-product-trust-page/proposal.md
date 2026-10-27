## Why

榜单行已经带着 formula、warnings 和 confidence，但用户点进一行时看不到「这个单价凭什么可信」：落库规格、可回放公式和它在同类里的位置都不在一页上。小程序路线里的商品信任页就是补这一层说明。端上若用标价和规格再乘一遍，会和落库 formula 各说各话。

## What Changes

- 新增公开只读 `GET /products/:id`。`:id` 是榜单行的 `unit_price.id`（快照 `id`），不是 `product.id`。响应给出展示用的规格、存储的 `per100ml` / `formula` / `confidence` / `warnings`，以及一小段 cohort。
- cohort 用与 `/rankings` 相同的快照准入和 `cohortSlugs`，名次取该行在服务端序里的位置；单价用存储列，读路径不调用 `calculate`。样本不够或品类含糊时返回 `partial` / `empty`，不编造名次或百分位。
- 小程序从榜单行进入信任页，展示规格、formula、warnings、confidence、采集时间、整件价/历史低，以及 cohort。端上只格式化，不从标价和规格重算 `per100ml` / `per100g`。
- `/rankings` 响应形状不变，不增加 `per100g`。

## 非目标

- 不爬山姆，不加抓取器，不写库，不调 LLM，不改 tier1 规则或模型。
- 不做商品图、纠错、贡献、收藏。
- 不把 `per100g` 放进 `/rankings`，不在读路径重算单价。
- 不把信任页放进 CDN 长 TTL / 预热清单（按 id 分键）。
- 不新增 `comparable` / `excludedReason`。

## Capabilities

### New Capabilities

- `product-trust`: `GET /products/:id` 的只读信任载荷：规格、存储单价与 formula、warnings/confidence、诚实 cohort。

### Modified Capabilities

- `persistence`: 按 `unit_price.id` 只读取出已存规格，不重算。
- `api-client`: 信任响应的 Zod 契约、URL 与 jitless 解析。
- `miniapp`: 榜单行进入信任页，展示服务端字段且不重算单价。
- `api-governance`: 该 GET 豁免公共治理，不扩大受保护集合。
- `deployment`: 成功响应 `no-store`，不进入长 TTL 预热目标。

## Impact

- `packages/db` 增加只读查询；`packages/api-client` 增加契约；`apps/api` 增加路由；`apps/miniapp` 增加页面与行内入口。
- 不改表结构，不跑生产迁移。
- 合规：只读已落库的主动提交数据，不触碰抓取或众包写入。
