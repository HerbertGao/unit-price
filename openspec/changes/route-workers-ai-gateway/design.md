## Context

生成式解析经 `agents/models/ai-sdk` 的 `createAI`。该 helper 对 `@cf/` 模型调用 `env.AI.run(model, input, { gateway, returnRawResponse: true })`。未传网关 id 时，解析结果是 `"default"`，首次请求会用到另一个网关。Clef 不经过 `createAI`，它走 `runWorkersAi` → `binding.run` 或 `POST /accounts/{id}/ai/run/{model}`。

REST 上，`createAI({ accountId, apiToken, gateway })` 会给 `/ai/run` 加上 `cf-aig-gateway-id`。Clef 的手写 fetch 需要自己加同一个头。binding 上的规范形状是第三个参数 `gateway: { id }`。

## Goals / Non-Goals

**Goals:**

- 生产 binding 上，生成式解析与 Clef 的 `AI.run` 都带 `gateway.id = unit-price`。
- Node / eval REST 上，两条路径都把同一 id 交给 AI Gateway。
- `reasoning_effort: "none"` 保持。

**Non-Goals:**

- 不调用 Cloudflare API 创建或修改网关。
- 不设置 `skipCache`、缓存 TTL 或计费模式。网关自己的缓存与账单配置保持原样。
- 不改模型 id 与 Clef 阈值。

## Decisions

1. **网关 id 常量放在 `config.ts`。** `workersAiRunOptions` 把 `gateway.id` 写成该常量，并保留调用方已有的 run 选项（尤其是 `returnRawResponse` 与 `signal`）。丢掉它们会让 `createAI` 收不到 `Response`。
2. **生成式 binding 两处一起设。** `createAI({ gateway: AI_GATEWAY_ID })` 让 helper 选对网关；`forceReasoningNone` 再强制一次 id，避免 helper 回落到 `default`。Clef 只走 `runWorkersAi`，用同一个 helper。
3. **REST 不改 URL。** 仍是 `https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}`。生成式由 `createAI` 带头；Clef 由 `runWorkersAi` 带头。头的名字是 `cf-aig-gateway-id`。
4. **不把 id 放进 wrangler 或 secret。** 它不是凭据。换网关要改常量并重新部署。

## Risks / Trade-offs

- 网关若不存在，或与 Worker 不在同一账号，推理会失败。上线前网关已经建好。
- 网关若打开了缓存，相同请求可能命中缓存。代码不覆盖这项设置。
- `createAI` 的网关字段是实验 API。binding 包装仍把 id 写在 `AI.run` 的第三个参数上，不依赖 helper 的内部字段名之外的行为；REST 生成式路径依赖 helper 发送 `cf-aig-gateway-id`。

## Migration Plan

1. 确认账号里已有 AI Gateway `unit-price`，且 Workers AI 计费保持现状。
2. 部署 Worker。无需新的 secret，无需新建网关。
3. 在该网关的日志里应能看到生成式模型与 `@cf/cloudflare/clef-flash`。
4. 回滚：恢复上一版 Worker。网关保留，不删除。

## Open Questions

无。
