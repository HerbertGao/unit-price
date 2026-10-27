## ADDED Requirements

### Requirement: 生成式 SpecParserLLM 走 Workers AI

系统必须提供 `SpecParserLLM` 领域端口：输入 `RawProduct`，输出经 Zod 校验的 `ParsedSpec` 或可区分的失败信号。端口实现必须经 Workers AI 调用生成式模型，默认模型为 `@cf/deepseek-ai/deepseek-v4.1-flash-1017`，且该解析请求的 `reasoning_effort` 必须是字符串 `none`。模型 id 由配置决定，禁止在业务调用点另写一份。生产路径使用注入 env 的 `AI` binding，不读取 OpenRouter 凭据。tier2 生成式解析必须只存在于 `apps/api`，禁止进入 `packages/core`。当底层调用发生 transport 失败（超时 / 网络错 / 5xx / 空响应）时，端口必须以可区分的失败信号返回，禁止伪造 `ParsedSpec`。Workers AI 未配置（无可用 `AI` binding，且没有成对的账号 id 与 API token）属配置错误，必须以与 transport 失败可区分的错误返回。当模型返回结构合法但字段全空的对象时，该对象按解析结果进入下游，不视为 transport 失败。端口必须保留可选的模型档位参数；传与不传均合法，本次只实现单档。

#### Scenario: 模型经配置切换

- **WHEN** 配置中的 model 字符串改为另一个 Workers AI 模型 id
- **THEN** 解析链路必须无需改动业务调用点即使用该 id

#### Scenario: transport 失败返回可区分信号

- **WHEN** 生成式调用超时或返回空响应
- **THEN** 端口必须以失败信号返回，禁止把它当作一次成功解析

#### Scenario: 升级扩展位形状预留

- **WHEN** 调用方传入或不传入可选的模型档位参数
- **THEN** 两种调用都必须合法

#### Scenario: 端口对业务暴露领域语言

- **WHEN** `apps/api` 的编排代码调用解析能力
- **THEN** 它必须只依赖 `SpecParserLLM` 的领域接口，禁止直接依赖 provider SDK 类型

#### Scenario: Workers AI 未配置为可区分配置错误

- **WHEN** 请求 env 没有可用的 `AI` binding，也没有成对的 Cloudflare 账号 id 与 API token
- **THEN** 系统必须以与瞬态 transport 失败可区分的 config-error 暴露，禁止退化为可重试的瞬态语义

#### Scenario: 解析请求关闭推理

- **WHEN** 生成式端口通过 `AI` binding 发起解析
- **THEN** `env.AI.run` 收到的对象必须包含 `reasoning_effort` 为 `none`，模型 id 为当前配置的生成式模型
