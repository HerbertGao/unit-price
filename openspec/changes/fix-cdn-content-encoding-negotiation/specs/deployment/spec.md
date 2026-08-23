## ADDED Requirements

### Requirement: 公共读 CDN 必须遵守客户端内容编码能力

经国内 CDN 提供的 `/rankings` 与 `/categories` 成功响应 MUST 只使用请求 `Accept-Encoding` 明确声明的内容编码；请求未声明编码或声明 `identity` 时，响应 MUST 为未压缩 JSON。CDN 缓存 MUST NOT 把由 zstd/Brotli 客户端填充的压缩副本复用于不支持该编码的客户端。

#### Scenario: identity 客户端命中缓存仍得到原始 JSON
- **WHEN** 客户端以 `Accept-Encoding: identity` 请求裸 `/rankings` 或 `/categories`，且该 URL 已有 CDN 缓存
- **THEN** 响应为 `200 application/json`，不带非 identity 的 `Content-Encoding`，响应体可直接解析为 JSON

#### Scenario: gzip-only 客户端不收到 br 或 zstd
- **WHEN** 客户端以 `Accept-Encoding: gzip` 请求任一公共读 URL
- **THEN** 响应编码只能为空/identity 或 gzip，MUST NOT 返回 `br` 或 `zstd`;解码后 `/rankings` 必须含数组 `rows/categoryNodes/excluded`,`/categories` 必须含数组 `nodes`

#### Scenario: zstd-capable 首次填充不得污染其它客户端
- **WHEN** 某个支持 zstd 的客户端先请求一个冷缓存公共读 URL
- **THEN** 后续 identity 或 gzip-only 请求仍必须得到自身可解码的响应，而不是该 zstd 副本

### Requirement: CDN 编码配置变更必须按配置、刷新、预热、验收顺序执行

生产 CDN 编码修复 MUST 先保存当前域名配置并使新的回源编码规则生效，再刷新 `/rankings` 与 `/categories` 的裸 URL，随后预热并验证；MUST NOT 在配置生效前预热，MUST NOT 预热任何 query 变体。新增配置必须保留可删除的配置 ID 作为回滚 handle。

#### Scenario: 配置生效后才替换旧压缩缓存
- **WHEN** 运维修复已存在的不兼容压缩副本
- **THEN** 必须依次完成配置快照、回源规则生效确认、两个裸 URL 刷新、两个裸 URL 预热和 identity/gzip 验收

#### Scenario: 验收失败不得宣告恢复
- **WHEN** 任一 URL 仍向 identity/gzip-only 请求返回未声明的编码，或响应体无法解析为 JSON
- **THEN** 修复必须判失败并保留诊断信息，MUST NOT 以 HTTP 200 或预热任务创建成功作为恢复依据

#### Scenario: 回滚使用配置 ID 并重新刷新缓存
- **WHEN** 新回源规则导致源站不可达或响应异常
- **THEN** 运维必须用记录的配置 ID 删除该规则，再刷新并预热两个裸 URL，且重新执行同一组验收

### Requirement: 定时 CDN 预热必须检测内容编码漂移

定时 CDN Warm workflow 的每次预热请求 MUST 显式移除默认 `Accept-Encoding: gzip`,使回源配置漂移时 warm 本身也不会先写入压缩副本。预热后 MUST 对 `/rankings` 与 `/categories` 执行 identity 与 gzip-only 探针。任一探针收到未声明编码、非 200、非 JSON、缺少端点必要数组 envelope 或全量失败时，workflow MUST 失败，禁止只凭 `PushObjectCache` 返回成功而静默绿。

#### Scenario: 配置漂移时预热本身不写入压缩副本
- **WHEN** 回源 identity 配置意外缺失而定时 warm 运行
- **THEN** `PushObjectCache` 仍必须以无 `Accept-Encoding` 的请求回源,不得使用其默认 gzip 头填充共享缓存

#### Scenario: 周期预热发现 zstd 回归
- **WHEN** 定时预热后，identity 或 gzip-only 探针收到 `Content-Encoding: zstd`
- **THEN** workflow 必须失败并指出 URL、请求编码和实际响应编码

#### Scenario: 两个 URL 与两种客户端能力均通过
- **WHEN** `/rankings` 与 `/categories` 对 identity/gzip-only 请求都返回可解码 JSON
- **THEN** workflow 才可把编码兼容检查标为成功
