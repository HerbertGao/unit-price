## Why

tier2 生成式解析目前经 OpenRouter 计费。生产路径应只使用 Cloudflare Workers AI，使模型账单留在 Cloudflare 账号。与此同时，生成式调用较贵、默认推理还会多耗 token；对明显抽不出规格的标题，以及解析后可疑的数量/拼单标题，需要一个不改写 `ParsedSpec` 的决策补全。

## What Changes

- 生成式 `SpecParserLLM` 改为 Workers AI `@cf/deepseek-ai/deepseek-v4.1-flash-1017`，经 `agents` 的 `createAI` 接 `env.AI`（生产）或 account id + API token（Node / eval）。`reasoning_effort` 固定为字符串 `none`。
- 生产路径不再读取 `OPENROUTER_API_KEY`，也不再依赖 `@ai-sdk/openai-compatible`。
- 在同一编排里增加 Clef-flash（`@cf/cloudflare/clef-flash`）决策补全：仅当 tier1 尚未确定时，先问「是否有可抽取规格」；生成式合并成功后再问数量是否可疑、标题是否像多件商品。答案只影响是否调用 generateObject 以及 warnings。
- `wrangler.toml` 为默认、production、preview 声明 `[ai] binding = "AI"`。

## 非目标

- 不用 Clef 填写 `unitSize`、`quantity` 或其他 `ParsedSpec` 字段，也不用它替代 tier2 结构化抽取。
- 不在 tier1 已确定的标题上调用任一模型，不新增队列，不保留 OpenRouter 双路径或功能开关。
- 不把 Clef 放进 eval 语料车道（eval 只跑生成式，避免语料调用翻倍）。
- 不改 tier3 公式、不新增 `comparable` / `excludedReason`，不做服务端爬取。

## Capabilities

### New Capabilities

- `spec-guard`：Clef-flash 在生成式解析前后的闸门与告警。

### Modified Capabilities

- `spec-parsing`：`SpecParserLLM` 的供应商、默认模型与配置错误来源。
- `deployment`：Workers AI binding 与 secret 面。
- `parse-api`：配置错误的例子从 OpenRouter key 改为 Workers AI 未配置。
- `eval-harness`：tier2 车道的启用条件改为 Workers AI REST 凭据。

## Impact

- `apps/api`（编排、配置、wrangler、README）、`packages/eval`（tier2 车道凭据）、`docs/architecture.md`。
- 合规面不变：仍是按请求解析，中心库只收主动提交的数据。
- 运维：账号需 Workers Paid 或 AI Gateway 额度；部署后删除残留 `OPENROUTER_API_KEY`。preview 与 production 共享 Workers AI 额度。
