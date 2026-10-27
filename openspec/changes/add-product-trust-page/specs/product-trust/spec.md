## ADDED Requirements

### Requirement: GET /products/:id 返回榜单行的信任载荷且不重算单价

`apps/api` MUST 提供 `GET /products/:id`。`:id` 是榜单快照行的 `id`（`unit_price.id`）。该端点只读：不写库、不调用 LLM、不调用 `calculate`、不出站抓取。

成功响应 MUST 满足 `@unit-price/api-client` 的 `ProductTrustSchema`。`per100ml`、`formula`、`confidence`、`warnings`、`priceCents`、`lowestPriceCents`、`capturedAt`、`title`、`store`、`storeSku`、`categorySlugs` MUST 来自与 `GET /rankings` 相同的快照准入结果中的那一行，不得用价格和规格重算覆盖。`confidence` MUST 是该行的 `unit_price.confidence`。响应 MUST NOT 包含 `per100g`。

`specs` MUST 来自该行对应 `product` 的已存列（单件、数量、乘数、总量、包装）。空列保持 null。MUST NOT 用单件乘数量补出总量，也 MUST NOT 把 `product.confidence` 当作响应里的 `confidence`。

不在已准入快照中的 id（未知、未入榜、重量轴、被行准入排除）MUST 返回 404，体为 `{ error: "not-found", message: "榜单里没有这件商品" }`。快照读取失败，或快照有该行但规格缺失/无法解码，MUST 返回 500 `persistence-error`，不得伪装成空 cohort。响应未过 schema MUST 返回 500 `internal`。

成功响应 MUST 带 `Cache-Control: no-store`。404 与 500 MUST NOT 带缓存头。

#### Scenario: 存储单价与 formula 原样返回

- **WHEN** 已准入行的 `per100ml` 为 0.505、`formula` 为 `40 / (330 * 24 * 1) * 100`，而它的规格若用当前 `priceCents` 重算会得到另一个数
- **THEN** `200` 的 `per100ml` 与 `formula` 等于该存储值，且响应没有 `per100g`

#### Scenario: 规格空列保持为空

- **WHEN** 该行的单件或总量列为 NULL
- **THEN** 对应 `specs` 字段为 null，不得用另一字段乘出来

#### Scenario: 未知 id 返回 404

- **WHEN** `:id` 不在已准入快照行中
- **THEN** 返回 404 与 `not-found`，且不读取规格

#### Scenario: 读失败返回 500

- **WHEN** 快照读取抛错，或该行在快照中但规格不存在或无法解码
- **THEN** 返回 500 `persistence-error`，不得返回带空 cohort 的 200

### Requirement: cohort 使用快照序并且在含糊时不编造数字

cohort MUST 从同一次已准入快照、用 `cohortSlugs` 切出。可比轴只有 `per_100ml`。`rank` MUST 是该 `id` 在过滤结果（服务端下发序）中的 1-based 位置。`percentile` MUST 是存储 `per100ml` 严格更大的行数除以 `total` 再乘 100。`peers` MUST 是该位置左右各最多 2 行、不含自己，字段只用存储的 `id` / `title` / `per100ml` 与上述名次。

`cohort` 查询缺省或空白时：该行恰好一个 `comparableUnit=per_100ml` 的 `categorySlugs` 则用它并 `status=ready`；零个则 `status=empty`；多于一个则 `status=partial`。查询给出的 slug 未知、节点 `comparableUnit` 为 null、不是 `per_100ml`，或该行不在其中，则 `status=empty`，正文仍 200。

`partial` 与 `empty` 时 `basis`、`rank`、`total`、`percentile` MUST 为 null，`peers` MUST 为空，`note` MUST 为非空说明。`ready` 时这些数字 MUST 非空，`note` MUST 为 null，`basis` MUST 为 `per100ml`。

#### Scenario: 名次等于榜单行号

- **WHEN** 客户端带上该行所属的 `per_100ml` cohort 请求此 id
- **THEN** `cohort.status` 为 `ready`，`rank` 等于该行在此 cohort 过滤序列中的位置，`percentile` 按严格更贵的份额计算，邻居不含自己且不超过左右各 2 条

#### Scenario: 并列时名次仍按服务端序

- **WHEN** 两行 `per100ml` 相等且都在同一 cohort，先下发的 id 更小
- **THEN** 两行的 `rank` 分别是它们在该序列中的位置，不得都变成 1

#### Scenario: 多归属且未指定 cohort 时不编造名次

- **WHEN** 请求不带 `cohort`，且该行有两个 `per_100ml` 品类归属
- **THEN** `cohort.status` 为 `partial`，名次、总数、百分位为 null，`peers` 为空，`note` 非空

#### Scenario: 无法定位时返回 empty

- **WHEN** `cohort` 未知、跨口径、不是容量轴，或该行不在该品类中
- **THEN** 返回 200，商品字段仍在，`cohort.status` 为 `empty`，名次与百分位为 null，`note` 非空
