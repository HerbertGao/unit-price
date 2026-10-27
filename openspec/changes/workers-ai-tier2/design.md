## Context

tier2 只存在于 `apps/api`。编排在 tier1 已能给出确定结论时不调用模型。原先 `generateObject` 经 OpenAI-compatible provider 指向 OpenRouter。Workers AI 的当前接法是 `agents/models/ai-sdk` 的 `createAI({ binding })` 或 `createAI({ accountId, apiToken })`，底层仍是 `env.AI.run` / REST，账单在 Cloudflare。

DeepSeek V4.1 Flash 的 `reasoning_effort` 接受 `max | high | low | none`，默认 `high`。`createAI` 把类型里的 `null` 译成删掉该字段并设置 `chat_template_kwargs.enable_thinking: false`，这不会提交字符串 `none`，模型仍按默认高推理计费。模型级选项里的字符串 `none` 会原样进入请求；binding 路径再包一层，向 `run` 的对象写入 `reasoning_effort: "none"`。Clef 不走这层包装。

Clef-flash 不是 chat 模型。请求体为 `{ model: "clef-flash", state, questions }`，noul 答案是 yes 的概率。binding 返回裸结果，REST 包在 `{ success, result }` 里。

## Goals / Non-Goals

**Goals:**

- 生产生成式解析只经 `AI` binding，失败分类保持 transport / config / invalid。
- 非确定标题上，Clef 可以少打一次生成式调用，或在不改 spec 的前提下加告警。
- Node 与 eval 用同一套 REST 凭据，binding 优先。

**Non-Goals:**

- 不在确定标题上跑 Clef（那会破坏「干净标题不触网」）。
- 不用 Clef 的 choice/score 填字段。
- 不为约 20 rpm 的默认限额新增队列。

## Decisions

1. **生成式走 `createAI`，不走手写 chat HTTP，也不走已废弃的 workers-ai-provider。** `generateObject` + `ParsedSpec` Zod 保持不变。REST 路径无法包 binding，靠模型选项上的字符串 `none`。
2. **配置面：binding 或成对的 `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`。** 只有其中一个、空白、或 `AI` 没有 `run`，都是缺失。binding 同时存在时忽略 REST 凭据。生产不把 token 放进 Worker secret。
3. **Clef 只挂在非确定分支。** `shouldParse` 的 P(yes) < 0.35 才跳过 generateObject，并附「标题未见可抽取规格，已跳过生成式解析」。概率缺失、抛错、或配置缺失都视为 unavailable，继续走生成式端口，因此缺配置仍是 `config-error` 而不是静默 200。
4. **复核只在生成式合并成功之后。** 一次调用两个 noul：数量可疑（仅当 `quantity != null` 且 P ≥ 0.75）、多件商品（P ≥ 0.75）。只追加 warning。复核抛错忽略。
5. **eval 不构造 Clef。** 启用条件改为两个 REST 环境变量都非空。无配置时记 `tier2 未评(无 Workers AI 配置)`。
6. **具名 wrangler 环境各自声明 `[ai]`。** 它们不继承顶层 binding。

## Risks / Trade-offs

- 跳过路径把「无规格 + 模型不可用」从 503 收成 200 不可计算，但只发生在 Clef 明确给出低概率时。缺配置仍是 500。
- `none` 依赖 provider 把未知档位原样下传。binding 包装是生产侧的保证；若以后 SDK 在进 `run` 之前把 `none` 收成 `null`，包装仍会写回字符串。
- preview 与 production 共享额度。解析量保持在现有请求路径上，不额外扫描。

## Migration Plan

1. 合并后部署 Worker（`[ai] binding = "AI"` 随 wrangler 配置生效）。
2. 确认账号有 Workers Paid 或 AI Gateway 额度。
3. `wrangler secret delete OPENROUTER_API_KEY`（production 与 preview）。
4. 回滚：恢复上一版 Worker。已删除的 OpenRouter secret 需另行写回，本变更不保留双路径。

## Open Questions

无。阈值 0.35 / 0.75 取保守侧，避免误跳过或误告警改写结果。
