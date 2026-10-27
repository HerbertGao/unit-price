## 1. 生成式供应商

- [x] 1.1 `apps/api`：`LlmConfig` 改为 AI binding 或 Cloudflare REST 凭据；默认模型 `@cf/deepseek-ai/deepseek-v4.1-flash-1017`；`generateObject` 经 `createAI`，并保证 binding 请求带 `reasoning_effort: "none"`。
- [x] 1.2 失败分类保持 config / transport / invalid。移除 `@ai-sdk/openai-compatible` 与 `OPENROUTER_API_KEY`。
- [x] 1.3 `packages/eval`：tier2 车道改读 `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`，不跑 Clef。

## 2. Clef 补全

- [x] 2.1 `apps/api`：`ClefSpecGuard` 用同一 `runWorkersAi` 问 noul。编排仅在 tier1 非确定时调用；跳过不改 spec；复核只加 warning。
- [x] 2.2 缺配置时 guard 不吞掉生成式 `config-error`。

## 3. 配置与验证

- [x] 3.1 `wrangler.toml` 为默认、production、preview 声明 `AI` binding。更新 `docs/architecture.md` 与 `apps/api/README.md`。
- [x] 3.2 单测覆盖配置面、binding 上的 `reasoning_effort`、Clef 阈值、编排闸门，以及 eval 无配置文案。
