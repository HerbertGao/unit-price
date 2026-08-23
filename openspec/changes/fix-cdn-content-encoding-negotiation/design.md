## Context

参见 `proposal.md`。生产链路为微信小程序 → 阿里云 CDN → Cloudflare custom domain → Worker。Cloudflare 会按回源请求的 `Accept-Encoding` 返回 identity/gzip/zstd，但响应不带 `Vary`;阿里云当前没有回源请求头或边缘压缩配置，并把首个压缩响应作为 URL 的单一缓存副本。实测裸 `/rankings` 对 identity/gzip 请求仍返回 zstd，而 query MISS 与直连源站均正常。

本机 `aliyun 3.4.11` 默认 AK profile 已通过只读 `DescribeCdnDomainConfigs` 验证；`origin_request_header`/gzip/Brotli 当前配置数为 0。配置快照保存于仓库外、权限为 0600。

## Goals / Non-Goals

**Goals:**
- 立即恢复微信真机对两个公共读端点的兼容访问。
- 保持裸 URL 单缓存对象与 1 天 TTL，不让压缩协商重新制造多副本漂移。
- 对生产配置提供可回滚 handle，并让定时预热检测编码回归。

**Non-Goals:**
- 不优化传输体积，不启用新的边缘压缩。
- 不改变 Worker 响应 schema、miniapp 请求代码或 CDN query 归一化。
- 不把阿里云凭据或完整配置快照写入仓库/日志。

## Decisions

### D1: 阿里云回源固定 `Accept-Encoding: identity`

用 `BatchSetCdnDomainConfig` 的 v2 `origin_request_header` 将回源请求头固定为 identity。这样 Cloudflare 始终返回原始 JSON，阿里云只缓存一个与客户端解码能力无关的对象。

备选方案：
- `Vary: Accept-Encoding`:会把同一大快照拆成多个缓存副本，且双 CDN 对 `Vary` 的端到端行为需要额外验证，不符合当前单对象目标。
- 固定 gzip:微信支持 gzip，但仍把编码体写入共享缓存，对 identity 客户端不成立。
- 客户端解 zstd:增加无必要依赖且修错层。

### D2: 配置变更必须有快照和 ConfigId

变更前用 `DescribeCdnDomainConfigs` 保存 0600 快照。配置调用形态为：

```sh
aliyun cdn BatchSetCdnDomainConfig \
  --DomainNames unit-price.herbert-dev.cn \
  --Functions '[{"functionName":"origin_request_header","functionArgs":[{"argName":"header_operation_type","argValue":"add"},{"argName":"header_name","argValue":"Accept-Encoding"},{"argName":"header_value","argValue":"identity"},{"argName":"duplicate","argValue":"off"}]}]'
```

从响应或随后查询中记录 `ConfigId`。回滚用 `DeleteSpecificConfig --DomainName ... --ConfigId ...`，而不是覆盖未知配置。

### D3: 配置生效后才刷新与预热

轮询 `DescribeCdnDomainConfigs --FunctionNames origin_request_header` 直到 `status=success` 且值为 identity，再分别刷新两个 File URL。刷新完成后调用 `PushObjectCache --WithHeader '{"Accept-Encoding":[" "]}'`，覆盖其默认 gzip 预热头；这样即使生产配置以后漂移，warm 本身也不会先写入压缩副本。不操作 query 变体。

### D4: 验收检查编码头和 JSON，而非只看 200

对每个 URL：
- identity 请求必须无压缩编码且首字节为 JSON 对象。
- gzip-only 请求只接受空/identity 或 gzip；拒绝 br/zstd，再解码并解析 JSON。
- `/rankings` 必须含数组 `rows/categoryNodes/excluded`,`/categories` 必须含数组 `nodes`,避免 `200 {error:...}` 假绿。
- 重复请求并确认缓存填充后仍满足相同条件。

现有 `cdn-warm.yml` 在 push 后执行同一检查并有短暂有界重试，以覆盖预热异步传播。探针不得输出凭据或完整榜单。

## Risks / Trade-offs

- [回源字节从约 30KB 增至约 145KB] → 只发生在 CDN miss/预热，1 天 TTL 下优先兼容性；有数据后再独立评估边缘 gzip。
- [阿里云配置传播有延迟] → 查询 active 后再刷新，验收使用有界重试。
- [刷新后先被其它客户端抢填] → 回源已强制 identity，任何首个请求都只能填入安全副本。
- [配置 ID 丢失导致回滚困难] → 同时从变更响应和 Describe 查询记录，快照留在仓库外。

## Migration Plan

1. 备份现有相关配置并记录基线探针。
2. 创建 `origin_request_header` identity 配置并记录 `ConfigId`。
3. 等待配置 active，分别刷新 `/rankings`、`/categories`。
4. 以显式无 `Accept-Encoding` 的 header 预热两个裸 URL,并执行 identity/gzip envelope 验收。
5. 更新 workflow/runbook 后走正常 PR；workflow 探针通过后保留配置。
6. 若源站或客户端异常，按 ConfigId 删除规则，刷新/预热并重新验收。
