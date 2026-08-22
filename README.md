# 单位价格比价系统（Unit Price）

一套「真实单价 / 规格归一化比价」系统。它不做同 SKU 跨店比价，而是把不同包装、容量和数量换算成可解释的单位成本，例如每 100ml 或每 100g。

> 给消费者装一个价格透视眼，拆开超市规格与整件价造成的错觉。

## 当前实现

| 模块 | 当前能力 |
| --- | --- |
| `packages/core` | 纯函数规则解析、单位换算、每 100ml / 每 100g 计算、formula 留痕与 warnings |
| `packages/db` | Cloudflare D1/SQLite + Drizzle；商品、单价、taxonomy、闭包与纠错表 |
| `apps/api` | Hono Worker：`/parse`、写入/批量 ingest、榜单快照、品类树、无状态即时比价、admin backfill |
| `packages/api-client` | API Zod 契约、URL 构造、快照本地 cohort/search/page 派生 |
| `packages/eval` | 山姆样本离线解析回归基线 |
| `apps/miniapp` | Taro 3-Tab 小程序：榜单、分类、我的、本地搜索/SWR、结构化即时比价与本地历史 |

技术边界以 [`docs/architecture.md`](docs/architecture.md) 为准；API 路由、治理和配置只在 [`apps/api/README.md`](apps/api/README.md) 维护完整清单。

## 常用验证

```sh
pnpm -r build
pnpm -r test
pnpm --filter @unit-price/api-client typecheck:test
pnpm --filter @unit-price/api typecheck:test
pnpm --filter @unit-price/miniapp typecheck
pnpm --filter @unit-price/miniapp build:weapp
```

## 文档

- [架构与现实边界](docs/architecture.md) — 技术单一事实源
- [API 路由、治理与部署](apps/api/README.md)
- [小程序当前状态与后续路线](docs/miniapp-roadmap.md)
- [生产回填 Runbook](docs/backfill-runbook.md)
- [需求源讨论](qa.md) — 历史问题空间，不代表当前实现
