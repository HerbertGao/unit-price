## ADDED Requirements

### Requirement: tier2 打分车道使用 Workers AI 凭据

系统必须提供跑批器：对语料逐条调用 `@unit-price/core` 的 tier1 解析与 tier3 计算，在同时配置了 `CLOUDFLARE_ACCOUNT_ID` 与 `CLOUDFLARE_API_TOKEN` 时另跑 tier1+tier2 一档。该档只调用生成式 `SpecParserLLM`，不得为了打分再调用 Clef。必须计算并输出 `unitSize` / `quantity` / `totalAmount` 召回率、可算率、`quantity` 相对 `samPkgNum` 的精度、per-unit 价误差，以及 tier1-only 与 tier1+tier2 的对比。无 Workers AI 配置时只评 tier1，报告注明未评 tier2，且不得因此失败。

#### Scenario: 未配置 Workers AI

- **WHEN** 运行跑批且账号 id 或 API token 缺失
- **THEN** 只输出 tier1 车道，并注明 tier2 未评，进程不因缺配置而失败
