## ADDED Requirements

### Requirement: AI Gateway unit-price 不是新的部署 secret

生产 Worker 必须把 Workers AI 推理记到已存在的 AI Gateway `unit-price`。该 id 必须来自代码常量，禁止写成 `wrangler.toml` 里的密钥或新的 runtime secret。部署不得调用 API 创建或修改该网关，也不得把该网关的 Workers AI 计费模式改为预付。Workers Paid 仍是付费模型的前提，与是否经过该网关无关。`CLOUDFLARE_API_TOKEN` 仍只作为 CI 部署凭据，以及 Node / eval 在没有 `AI` binding 时的 REST 凭据。

#### Scenario: 部署不新增网关配置

- **WHEN** 部署 production 或 preview Worker
- **THEN** 配置里不得出现新的 Workers AI token secret，也不得要求新建网关或把 `unit-price` 改成预付计费

#### Scenario: 网关 id 不进 wrangler 明文

- **WHEN** 检查 `wrangler.toml`
- **THEN** 其中不得写入 AI Gateway 的凭据；网关 id 只存在于应用代码常量
