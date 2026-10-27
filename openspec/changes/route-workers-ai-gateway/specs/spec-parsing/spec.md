## ADDED Requirements

### Requirement: Workers AI 调用经过 AI Gateway unit-price

`apps/api` 发出的每一次 Workers AI 推理（生成式 `SpecParserLLM` 与 Clef 闸门/复核）必须经过同一 AI Gateway，id 为 `unit-price`。该 id 必须只定义一次，业务调用点不得再写另一个网关 id。生产 binding 路径必须把 `gateway: { id: "unit-price" }` 传给 `env.AI.run` 的选项参数。Node / eval 使用账号 id 与 API token 的 REST 路径必须把同一 id 放进 `cf-aig-gateway-id`。生成式请求的 `reasoning_effort` 仍必须是字符串 `none`。缺少 Workers AI 配置时的 config-error 语义不变。系统不得为了接上网关而改模型 id 或新建网关。

#### Scenario: 生成式 binding 带上网关 id

- **WHEN** 生成式端口通过 `AI` binding 发起解析
- **THEN** `env.AI.run` 的选项必须包含 `gateway.id` 为 `unit-price`，请求体的 `reasoning_effort` 必须为 `none`，模型 id 为当前配置的生成式模型

#### Scenario: Clef binding 带上同一网关 id

- **WHEN** Clef 闸门或复核通过 `AI` binding 发起调用
- **THEN** `env.AI.run` 的选项必须包含 `gateway.id` 为 `unit-price`，模型 id 为 `@cf/cloudflare/clef-flash`

#### Scenario: REST 路径使用同一网关

- **WHEN** 没有 `AI` binding、但配置了成对的 Cloudflare 账号 id 与 API token，且生成式端口或 Clef 发起调用
- **THEN** 请求必须发往账号下的 Workers AI run 端点，并带 `cf-aig-gateway-id: unit-price`
