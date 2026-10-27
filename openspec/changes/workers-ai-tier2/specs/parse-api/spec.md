## ADDED Requirements

### Requirement: Workers AI 配置错误与信息不足可区分

运行期配置错误（Workers AI 未配置，且未在启动期 fail-fast）必须返回明确的 5xx，且错误体须与「信息不足 5xx」可区分（不同 error code）。实现层为 `config-error`（HTTP 500）与 `insufficient-information`（HTTP 503）。

#### Scenario: 缺 Workers AI 配置

- **WHEN** 需要 tier2 的请求到达，且 env 没有可用的 Workers AI 配置
- **THEN** 响应为 `config-error`，而不是 `insufficient-information`
