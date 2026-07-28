## 0. 先验(结论可能否定整个方案)

- [ ] 0.1 **实测首屏代价**:构造一份当前全量快照(389 行 + 叶品类 slug)的响应体,量其原始 / gzip 体积与在真机上的首屏时间,与现状(20 行首页)对比。**若首屏明显变慢,本设计的收益不成立** —— 收益是「后续零网络」,代价是「首次更重」,这笔账必须先算,不能只报告缓存键数量
- [ ] 0.2 记录当前榜单行数与增长率作为 D5 阈值的基线

## 1. 服务端:快照端点(`apps/api` + `packages/db`)

- [ ] 1.1 `packages/db` 增加全量查询:取 `per100ml` 非空且 `rankable` 的全部行,附带其叶品类 slug。**不分页**;纯读、无写
- [ ] 1.2 把 `/rankings` 现有的行投影**抽成共用函数**,快照与 `/rankings` **同时**改用它 —— 对应「字段同源」场景,**禁止**复制出两份投影
- [ ] 1.3 新增只读端点:不接受品类 / 搜索 / 分页参数;行**不含** `rank`;治理豁免口径与 `/rankings` 一致;设可被 CDN 缓存的 `Cache-Control`(取值见 design 的 Open Questions)
- [ ] 1.4 确定性 tie-breaker:定义 `per100ml` 相等时的次级排序键,**同时**应用到 `/rankings` 的 `ORDER BY`(两侧口径必须一致,否则小程序与 web 顺序不同)
- [ ] 1.5 行数可观测(响应内或日志),供 D5 的阈值判断
- [ ] 1.6 单测:全量返回、不接受过滤参数、行含叶 slug 且不含 `rank`、与 `/rankings` 共有字段逐字相同、tie-breaker 可复现
- [ ] 1.7 核对 `GET /rankings` 请求/响应契约**零变更**(除 1.4 的次级排序键外行为不变),路由表 diff 仅新增一条

## 2. api-client:快照契约与端上派生(`packages/api-client`)

- [ ] 2.1 快照 schema:按引用复用 `RankingsItemSchema` 并加叶品类 slug(**必须** `.optional()`);URL 构造 + 解析函数,形态与 `parseRankingsResponse` 一致(只接 `json`、内部 `{ jitless: true }`、失败抛 `ZodError`)
- [ ] 2.2 排序能力:按 `per100ml` 升序 + 确定性 tie-breaker(与 1.4 同口径);**禁止**重算单价
- [ ] 2.3 品类过滤:入参为 slug + `/categories` 树,沿 `parentSlug` 判定祖先归属;`comparableUnit === null` 的节点**必须**拒绝并给出可呈现原因
- [ ] 2.4 本地搜索:子串匹配口径(大小写、全角/半角)**必须**与服务端 `q` 一致 —— 实现前先读服务端 `q` 的实际匹配实现,把差异列出来再动手
- [ ] 2.5 分页:对已排序已过滤结果切片并赋 `rank = offset + 1-based index`
- [ ] 2.6 单测:祖先过滤含全部后代、跨 cohort 拒绝、tie-breaker 可复现、`.optional()` 使缺字段的旧响应仍解析通过
- [ ] 2.7 **同口径对照测试**:同一份数据下,本地「过滤+排序+分页+搜索」的结果与 `GET /rankings` 对应参数的返回**逐字相同**(至少覆盖:默认榜、一个叶品类、一个祖先节点、一个搜索词、第二页)

## 3. miniapp:五条需求的数据来源切换(`apps/miniapp`)

- [ ] 3.1 榜单 Tab 首屏改为消费快照 + 本地派生;端上 SWR 缓存由「每 cohort 一份」改为「一份快照」
- [ ] 3.2 分页改为本地切片;重验**禁止**重置用户当前翻页位置
- [ ] 3.3 分类树下钻改为本地过滤(不发请求);`rankable=false` 节点仍为不可点分组头,理由改为「跨可比口径」
- [ ] 3.4 搜索改为本地筛选(不发请求),深链 `board?q=` 行为不变
- [ ] 3.5 清理:确认切品类 / 翻页 / 搜索**均不再发起网络请求**(用 devtools 网络面板逐条验)
- [ ] 3.6 真机验证**五条路径缺一不可**:榜单首屏、翻页、品类下钻、搜索、冷启动 SWR

## 4. 运维与文档

- [ ] 4.1 `docs/backfill-runbook.md` 的 CDN 一节:榜单相关缓存键由 15+ 收敛为 1,purge / 预热步骤同步简化(保留 `/categories` 与 `/rankings` 的既有条目——两者仍在)
- [ ] 4.2 记录 D5 的失效阈值与回退路径(超限即回退 `/rankings` 服务端分页),写进 runbook 或 design 的实测结论

## 5. 收口验证

- [ ] 5.1 `pnpm -r build` + `pnpm -r test` 全绿;`pnpm --filter miniapp build:weapp` 通过
- [ ] 5.2 **归档试跑**:副本上跑 `openspec-cn archive client-side-rankings -y`,确认无硬中止(本变更有 5 条 MODIFIED,是 `validate --strict` 抓不到的标题坑的高危区)
- [ ] 5.3 prod 验活:快照端点返回行数与库内 `per100ml` 非空且 `rankable` 的计数一致;刷 CDN 后端上各视图正确
