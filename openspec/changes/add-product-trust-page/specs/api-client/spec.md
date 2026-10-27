## ADDED Requirements

### Requirement: api-client 必须提供产品信任契约

`packages/api-client` MUST 定义 `ProductTrustSchema`（types 由此推导），以及 `buildProductTrustUrl` 与 `parseProductTrust`。模块不得发网络请求。

`ProductTrustSchema` MUST 是 strict object，字段为：`id`、`title`、`priceCents`、`lowestPriceCents`、`capturedAt`、`per100ml`、`formula`、`confidence`、`warnings`（复用 core `WarningsSchema`）、`store`、`storeSku`、`specs`、`categorySlugs`、`cohort`。MUST NOT 声明 `per100g`。`specs` 含 `unitSize` 与 `totalAmount`（`{ value, unit }` 或 null，`unit` 为 `ml|L|g|kg`）、`quantity`（number 或 null）、`multipliers`（number 数组）、`packageUnit`（string 或 null）。`cohort.status` 为 `ready|partial|empty`。`peers` 每项为 `id`、`title`、`per100ml`、`rank`，最多 4 条。

`ready` 时 `basis` 为 `per100ml`，`slug`、`name`、`rank`、`total`、`percentile` 非空，`note` 为 null，`rank` 在 `1..total`，`percentile` 在 `0..100`，`peers` 的 id 不得等于本体 id。`partial` 与 `empty` 时 `basis`、`rank`、`total`、`percentile` 为 null，`peers` 为空，`note` 非空。

`buildProductTrustUrl(base, id, cohort?)` MUST 用与 `buildRankingsUrl` 相同的 clean origin 规则。`id` 空白 MUST 抛错。路径为 `<origin>/products/<encodeURIComponent(id)>`。`cohort` 缺省或空白时不得带查询；否则带 `cohort` 查询参数。

`parseProductTrust(json)` MUST 只接受一个参数，内部固定 `{ jitless: true }`，失败抛 `ZodError`。

#### Scenario: 多一个 per100g 字段则校验失败

- **WHEN** 载荷在信任对象上多了 `per100g`
- **THEN** `parseProductTrust` 抛错

#### Scenario: partial cohort 不得带名次

- **WHEN** `cohort.status` 为 `partial` 且 `rank` 非 null
- **THEN** schema 校验失败

#### Scenario: URL 只在有 cohort 时带查询

- **WHEN** 调用 `buildProductTrustUrl` 且 cohort 为空
- **THEN** 结果没有查询串
- **WHEN** cohort 为非空字符串
- **THEN** 结果带编码后的 `cohort` 参数，且 id 出现在路径中
