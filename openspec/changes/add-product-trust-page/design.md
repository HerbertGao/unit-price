## Context

`GET /rankings` 已经把可比行的 `per100ml`、`formula`、`confidence`、`warnings`、价格和 `capturedAt` 放进一份快照，`id` 是 `unit_price.id`。规格（单件、数量、乘数、总量、包装）在 `product` 表，不在快照里。没有商品详情路由。小程序榜单行不可点进说明页。

读路径禁止重算单价。`priceCents` 与 `formula` 可以短暂不一致，两边都要原样给人看，不能在端上用标价乘规格把它们「对齐」。

## Goals / Non-Goals

**Goals:**

- 用榜单行 `id` 打开一页，看到落库规格、存储 formula、warnings/confidence、采集时间，以及一小段同类位置。
- 名次与 `/rankings` 同一套准入、同一条服务端序。
- 样本不够或品类含糊时明确说给不出名次。

**Non-Goals:**

- 不改 `/rankings` 形状，不把 `per100g` 放进榜单。
- 不重算、不调 LLM、不写库、不爬站、不加图片和纠错。
- 不把按 id 的响应放进长 TTL CDN。

## Decisions

1. **新的 `GET /products/:id`，不扩快照。** 规格只在打开这一页时需要。塞进 `/rankings` 会改那份唯一缓存对象的形状。没有现成的详情端点可扩。`:id` 用榜单 `id`（`unit_price.id`），因为列表上没有 `product.id`。
2. **单价字段只从已准入的快照行投影。** `per100ml` / `formula` / `confidence` / `warnings` / 价格 / `capturedAt` 与该行在 `/rankings` 里的值相同。`confidence` 是 `unit_price.confidence`，不是解析期的 `product.confidence`。不在响应里放 `per100g`。不在榜上的 id（未知、重量轴、形状被排除）返回 404。
3. **规格另查 `product` 列。** `getStoredSpecByUnitPriceId` 只解码已存列并用 `ParsedSpecSchema` 校验，不调用 `calculate`。半截测量或坏 JSON 抛错，路由回 500，不补一个算出来的总量。快照有行但规格读不到，也是 500，不编造规格。
4. **cohort 用快照，不用 `positionInCohort`。** 比价的 `positionInCohort` 把「用户值」插进序列，并列时名次会和榜单行号不一致。信任页的 `rank` 是该 `id` 在 cohort 过滤结果里的 1-based 下标，序与榜单相同。`percentile` 仍是「存储 `per100ml` 严格更贵的行数 / total × 100」。左右各最多 2 个邻居，用它们的存储 `per100ml`，不含自己。
5. **cohort 查询参数决定看哪张榜。** 落地榜是 `soft-drink`，商品挂的往往是更细的叶。不带参数时：恰好一个 `per_100ml` 归属就用它；零个为 `empty`；多个为 `partial`，名次和百分位为 null。带了参数但不认识、跨口径、不是容量轴，或这件商品不在里面，返回 `empty` 加说明，商品正文仍是 200。不编造数字。
6. **`Cache-Control: no-store`。** 按 id（再加 cohort）分键。阿里云 CDN 会缓存未声明 `no-store` 的响应。这个端点不进预热清单。
7. **公共读、治理豁免。** 与 `/categories` 相同：不挂鉴权。受保护集合不变。
8. **端上只格式化。** 大字是服务端 `per100ml` 的两位小数展示。百分位文案是服务端 `percentile` 的四舍五入，不是用 rank/total 再算。`total < 2` 时不说「比 X% 便宜」。列表上的置灰、单件 warning、历史低保留，行上加进入信任页的入口。

## Risks / Trade-offs

- [规格和 formula 对不上] → 两边都展示存储值，不在读路径调和。这是既有的价格窗口，不是信任页要修的。
- [不带 cohort 的深链名次和落地榜不同] → 从榜单进入时带上当前 cohort。深链在多归属时走 `partial`。
- [每次打开都读全量快照] → 与 `/compute` 相同，当前行数是百级。换来名次和榜单一致。
- [404 与「库里有这条但没入榜」无法区分] → 信任页只解释榜上的单价。重量轴不在本期。

## Migration Plan

无表结构变更，不跑迁移。部署 Worker 即可。`/rankings` 形状不变，不必为此 purge。回滚到上一版 Worker；`no-store` 不会在边缘留下信任页缓存。

## Open Questions

无。
