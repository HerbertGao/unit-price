## 1. 契约与只读规格

- [x] 1.1 `packages/api-client`：新增 `ProductTrustSchema`、`buildProductTrustUrl`、`parseProductTrust`，并从包入口导出。不发请求，不声明 `per100g`。
- [x] 1.2 `packages/api-client`：单测覆盖 strict 拒绝 `per100g`、`partial` 不得带名次、URL 仅在有 cohort 时带查询、`jitless` 解析。
- [x] 1.3 `packages/db`：`getStoredSpecByUnitPriceId` 只读解码 `ParsedSpec`。未知 id 返回 null，半空测量列抛错，不调用计算。配 repository 单测。

## 2. API

- [x] 2.1 `apps/api`：`GET /products/:id` 从已准入快照投影单价字段，规格走 1.3，cohort 按设计放置。404 / 500 / `no-store` / 治理豁免。不改 `/rankings`。
- [x] 2.2 `apps/api`：路由单测覆盖不重算、并列名次、partial/empty、404 不读规格、读失败 500、无 key 放行。真实 SQLite 的 board e2e 断言响应与快照行一致。
- [x] 2.3 更新路由清单测试，以及 `apps/api/README.md`、`docs/architecture.md`、`docs/miniapp-roadmap.md`。预热清单不加入 `/products/`。

## 3. 小程序

- [x] 3.1 `apps/miniapp`：榜单 Tab 与 board 行进入 `pages/trust`，URL 带 id 与当前 cohort。计算页邻居不进入。列表置灰、warning、历史低保留。
- [x] 3.2 信任页用 api-client 取数并展示规格、formula、warnings、confidence、新鲜度、价格和 cohort。空规格为「未解析」。`partial`/`empty` 只显示 note。百分比只四舍五入服务端 `percentile`。`total < 2` 不显示百分比。样式只用 CSS 变量。
- [x] 3.3 纯函数单测：展示用的 `per100ml` 来自载荷而不是价格乘规格；cohort 文案；路由参数。

## 4. 验证

- [ ] 4.1 跑 `openspec-cn validate add-product-trust-page --strict` 与 `pnpm -r test`。本变更不改 `packages/core`，无新的脏标题样本。
