## 1. 生产热修复

- [x] 1.1 用 Aliyun CLI 重新保存 `origin_request_header,gzip,brotli` 配置快照与 identity/gzip 基线探针，确认快照权限为 0600 且输出不含凭据
- [x] 1.2 调用 `BatchSetCdnDomainConfig` 的 `origin_request_header` 将 `unit-price.herbert-dev.cn` 回源 `Accept-Encoding` 固定为 `identity`，记录 `ConfigId`，并以 `DescribeCdnDomainConfigs` 验证配置已 active 且值正确
- [x] 1.3 配置生效后分别刷新、预热裸 `/rankings` 与 `/categories`，验证 identity/gzip-only 请求在 MISS 与 HIT 下均不收到未声明编码且响应可解析为 JSON；失败时按 ConfigId 回滚并重复刷新验收

## 2. 漂移防护与运维文档

- [x] 2.1 在 `.github/workflows/cdn-warm.yml` 的每次预热调用显式移除 `Accept-Encoding`，并在预热后加入有界重试的 identity/gzip-only 探针，断言两个 URL 的状态、编码与端点数组 envelope；用 workflow 原样 shell 验证生产通过
- [x] 2.2 更新 `docs/backfill-runbook.md`，记录回源 identity 配置、预热 `WithHeader`、ConfigId 回滚、刷新顺序及四组合 envelope 验收，并检查文档不含 AK 或完整配置快照

## 3. 验证与交付

- [x] 3.1 运行 `openspec-cn validate fix-cdn-content-encoding-negotiation --type change --strict`、workflow YAML/格式检查与 `git diff --check`，确认全部通过
- [x] 3.2 手动 dispatch `CDN Warm` workflow，验证编码探针在 GitHub runner 上通过且生产 `/rankings` 真机兼容，再提交 feature 分支 PR 供 review
