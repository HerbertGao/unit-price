## ADDED Requirements

### Requirement: 榜单行必须能打开单价信任页且端上不重算

榜单 Tab 与 board 列表的每一行 MUST 能进入非 Tab 页 `pages/trust/index`。跳转 URL MUST 带该行快照 `id` 与当前列表 cohort（未指定 cohort 时用 `LANDING_COHORT`）。计算页的邻居行 MUST NOT 因此变成信任页入口。

信任页 MUST 用 `buildProductTrustUrl`、`Taro.request` 和 `parseProductTrust` 读取 `GET /products/:id`。MUST NOT 引入 `packages/core`，MUST NOT 用 `priceCents` 与 `specs` 计算 `per100ml` 或 `per100g`。

页面 MUST 展示：服务端 `per100ml`（仅作两位小数展示）、整件价、已有的历史低与失效判定、规格各字段（空为「未解析」）、`formula` 原文、`warnings`、`confidence`、`capturedAt`，以及 cohort。`cohort.status` 不是 `ready` 时 MUST 展示服务端 `note`，不得显示名次或「比 X% 便宜」。`ready` 且 `total >= 2` 时，「比 X% 便宜」的 X MUST 是服务端 `percentile` 的四舍五入，不得用 rank/total 另算。`ready` 且 `total < 2` 时 MUST 说明目前只有这一件，不得显示百分比。邻居只展示服务端给出的标题、名次和 `per100ml`。

页面 MUST 有加载态、失败可重试、404 说明。视觉 MUST 只用既有 CSS 变量。列表行原有的置灰、单件 warning 和历史低 MUST 保留。

#### Scenario: 从榜单行进入并展示服务端单价

- **WHEN** 用户在落地榜或分类榜点击一行
- **THEN** 打开信任页，请求带该行 id 与当前 cohort，大字等于该响应的 `per100ml`，而不是用整件价和规格算出来的数

#### Scenario: 含糊 cohort 不显示假名次

- **WHEN** 响应 `cohort.status` 为 `partial` 或 `empty`
- **THEN** 页面展示 `note`，不展示名次或百分比

#### Scenario: 列表上的既有标注还在

- **WHEN** 一行超过 30 天未重报、带单件 warning，或现价高于历史低
- **THEN** 这些标注仍在列表行上，信任页入口是额外的
