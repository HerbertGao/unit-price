## Why

阿里云 CDN 当前把 Cloudflare 按首个请求协商出的压缩响应缓存为 URL 的唯一副本：生产 `/rankings` 即使收到 `Accept-Encoding: identity` 或 `gzip, deflate`，仍返回 `Content-Encoding: zstd`，导致不支持 zstd 的微信真机 `wx.request` 解压失败。带随机 query 的 CDN MISS 和直连源站均返回正常 JSON，故问题位于双 CDN 的内容编码协商与缓存边界，需立即修复并增加漂移探针。

## What Changes

- 用已配置的 Aliyun CLI 先备份生产域名配置，再将阿里云回源请求头 `Accept-Encoding` 固定为 `identity`，确保 Cloudflare 压缩体不进入阿里云缓存；记录新 `ConfigId` 供回滚。
- 配置传播后刷新并预热裸 `/rankings`、`/categories` 两个缓存对象，禁止创建 query 变体。
- 定时 CDN warm 显式移除预热默认 gzip 头，并在预热后验证 identity/gzip-only 客户端不会收到未声明编码，且响应含端点必要数组 envelope；不兼容必须使 workflow 失败而非静默绿。
- 更新生产 CDN runbook，写明配置、回滚、刷新顺序和机械验收命令。

## 非目标

- 不在小程序中设置或伪造 `Accept-Encoding`，不加入客户端解压库。
- 不把 BASE 改回大陆网络不可稳定访问的 Cloudflare 源站，也不取消国内 CDN。
- 不改变 `/rankings`、`/categories` 的响应 schema、TTL、query 归一化或榜单数据。
- 不启用新的 gzip/Brotli/zstd 边缘压缩；先以单一 identity 回源副本换取兼容性，后续只有在测量证明需要时再独立优化。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `deployment`: 公共读 CDN 必须按客户端声明提供可解码响应；生产回源编码配置、刷新/预热顺序与定时兼容探针成为部署边界。

## Impact

- 生产外部配置：阿里云 CDN 域名 `unit-price.herbert-dev.cn` 的回源请求头配置与两个公共读缓存对象。
- 仓库：`.github/workflows/cdn-warm.yml`、`docs/backfill-runbook.md`、`openspec/specs/deployment/spec.md`（归档时同步）。
- 不触碰 `packages/core`、数据库、LLM、众包写入或合规敏感的数据采集面。
