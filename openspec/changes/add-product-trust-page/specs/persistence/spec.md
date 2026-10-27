## ADDED Requirements

### Requirement: repository 必须按 unit_price.id 只读已存规格

`@unit-price/db` 的 repository MUST 提供 `getStoredSpecByUnitPriceId(unitPriceId)`。它只读 `unit_price` 与 `product`，把已存的单件、数量、乘数、总量、包装、`category`、解析期 `confidence` 解码为 `ParsedSpec`。未知 id MUST 返回 null。列半空、JSON 损坏或过不了 `ParsedSpecSchema` 时 MUST 抛错。

该方法 MUST NOT 调用单价计算，MUST NOT 用价格推导 `per100ml` 或 `formula`，MUST NOT 写库。

#### Scenario: 按榜单 id 读回落库规格

- **WHEN** 某 `unit_price.id` 对应的 product 存有单件与总量
- **THEN** 返回的 `ParsedSpec` 与这些列一致

#### Scenario: 未知 id 返回 null

- **WHEN** 没有该 `unit_price.id`
- **THEN** 返回 null，不抛「缺失」错误

#### Scenario: 半空测量列抛错

- **WHEN** 单件的 value 与 unit 只有一个为 NULL
- **THEN** 方法抛错，不返回补全后的规格
