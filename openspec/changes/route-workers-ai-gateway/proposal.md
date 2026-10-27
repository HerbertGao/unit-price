## Why

生产上的生成式解析和 Clef 都打到 Workers AI，但请求没有固定记到已有的 AI Gateway `unit-price`。`createAI` 在未指定网关时会使用 id `default`，那会落到另一个网关。需要同一条观测入口，方便看日志、延迟和 token，也为以后若要切 Unified Billing 留好网关，而不在这次改计费模式。

## What Changes

- 生成式 `AI.run` 与 Clef 的 `AI.run` 都带 `gateway: { id: "unit-price" }`。网关 id 只有一处常量。
- Node / eval 的 REST 路径（`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`）对生成式走 `createAI({ gateway })`，对 Clef 走 `cf-aig-gateway-id`，目标同一个 id。
- 不新建网关，不改网关的 Workers AI 计费模式，不改模型 id、Clef 阈值或 `reasoning_effort: "none"`。

## 非目标

- 不把网关改成预付 Unified Billing，也不把预付额度写成上线条件。
- 不新增 secret，不改 wrangler binding。
- 不改模型、阈值、失败分类，不让 Clef 填写 `ParsedSpec`。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `spec-parsing`：Workers AI 调用必须经过网关 `unit-price`。
- `deployment`：网关 id 是代码常量，不是新 secret；部署不创建网关。

## Impact

- `apps/api` 的 `config.ts` / `llm.ts`、对应单测、`apps/api/README.md`、`docs/architecture.md`。
- eval 仍只跑生成式解析；它经 `AiSdkSpecParser` 的 REST 路径带上同一网关 id，不另调 Clef。
