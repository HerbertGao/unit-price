## 1. 代码:延长公共读 TTL

- [x] 1.1 `apps/api/src/routes.ts` 把 `PUBLIC_CACHE_CONTROL` 由 `public, max-age=300` 改为 `public, max-age=86400`,并更新其注释说明长 TTL 依据(价格月级稳定、临时优惠经 ingest、遵循源站已确认、purge/预热配套)。
- [x] 1.2 确认现有测试不锁具体 TTL 值(`apps/api/src/routes.test.ts` 断言 `/max-age=\d+/`、保留 `public`),改值不破坏。
- [x] 1.3 `pnpm -C apps/api test` 跑通(281 passed / 9 files;CI `verify` 亦绿):`/rankings`(非搜索)与 `/categories` 仍发 `public, max-age=…`、搜索/`compute` 仍 `no-store`。

## 2. 运维契约:runbook + 遵循源站确认

- [x] 2.1 `docs/backfill-runbook.md` 新增"数据更新后:刷新 CDN"小节(`RefreshObjectCaches` purge + `PushObjectCache`/curl 预热 + 遵循源站已确认无需配置)。
- [x] 2.2 实测确认阿里云 CDN 遵循源站 `Cache-Control`(`aliyun cdn DescribeCdnDomainConfigs` 无自定义 TTL 规则;curl 二次请求 `X-Cache: HIT`)。

## 3. 发布与验收

- [x] 3.1 **PR #51**(含代码 + runbook + deployment spec delta),review-loop 两轮 + CodeRabbit 后合并 main(push-to-deploy 自动 deploy prod)。
- [x] 3.2 部署后实测:`/rankings` 与 `/categories` 均返回 `Cache-Control: public, max-age=86400`;`/categories` 二次请求 `X-Cache: HIT`(边缘已缓存)。
- [x] 3.3 本次为 **TTL-only 部署、无数据变更** → 无需 purge(旧 300s 缓存 ≤5min 自然过期切新 TTL)。预热为可选优化,`/categories` 已 HIT;purge+预热仪式已写入 `docs/backfill-runbook.md`,留作**未来 ingest/backfill 数据变更时**执行。
