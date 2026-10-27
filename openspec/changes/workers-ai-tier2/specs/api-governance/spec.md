## ADDED Requirements

### Requirement: 鉴权先于 Workers AI 配置错误

业务侧 config-error（Workers AI 未配置）在业务环产生，会被鉴权前置遮蔽。治理侧 config-error（`API_KEYS` 缺失）在鉴权环产生，不被前置遮蔽。两者同为 `500 config-error`，来源不同。

#### Scenario: 缺客户端 key 时先 401

- **WHEN** 服务端未配置 Workers AI，且客户端也未携带 API key 的请求到达 `/parse`
- **THEN** 响应为 `401 auth-missing`，业务 config-error 分支不被评估
