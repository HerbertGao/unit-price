## ADDED Requirements

### Requirement: Workers AI 配置经注入 env 读取且请求间不串台

LLM 配置必须经显式传入的 env 对象读取：Workers 路径下 env 来自 fetch handler 的 `env` binding，本地 dev 路径下由入口层从 `process.env` 取值后注入。禁止在 app 工厂或路由模块作用域读取全局 `process.env`。

配置必须按请求从注入的 env 解析。默认每请求重建 LLM 端口。若实现在 isolate 内 memoize，键必须覆盖本次请求的 Workers AI 配置（`AI` binding 身份，或账号 id + token + model），禁止用首个请求的 env 服务后续不同 env 的请求。

缺可用 Workers AI 配置是配置错误，必须返回与「信息不足」可区分的 5xx。实现层沿用 `config-error`（HTTP 500）与 `insufficient-information`（HTTP 503）。干净标题（tier1 即可算）在无配置时仍返回 200。

`apps/api` 的 `wrangler.toml` 必须为默认、production、preview 声明 `AI` binding，名字与 `Bindings.AI` 一致。具名环境必须各自声明，不得依赖顶层 binding 继承。`API_KEYS`、`ADMIN_API_KEYS`、`AUDIT_LOG_HMAC_SECRET` 禁止写入 `wrangler.toml`。生产 Worker 不得把 Workers AI token 当作必填 secret。`CLOUDFLARE_API_TOKEN` 仍只作为 CI 部署凭据。

#### Scenario: Worker 使用 AI binding

- **WHEN** Worker fetch handler 收到请求且 `env.AI` 由 wrangler `[ai]` binding 提供
- **THEN** tier2 必须通过该 binding 调用 Workers AI，不得要求 OpenRouter secret

#### Scenario: 干净标题无配置仍 200

- **WHEN** 未配置 Workers AI，客户端 POST 一个 tier1 即可算的干净标题（如 `可口可乐 330ml*24听`，price 40）
- **THEN** 响应为 200，且不发起模型调用

#### Scenario: 需要 tier2 但未配置

- **WHEN** 未配置 Workers AI，且请求需要 tier2 补全
- **THEN** 响应为与信息不足可区分的 config-error

#### Scenario: 两个请求的 binding 不串台

- **WHEN** 连续两个请求分别注入不同的 `AI` binding 与空 env
- **THEN** 每个请求的 LLM 工厂只看到自己的 env
