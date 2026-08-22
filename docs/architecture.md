# 单位价格比价系统 — 当前技术架构

> 本文是架构与实现边界的单一事实源。路线愿景必须明确标为未来，不能写成仓库现状。

## 一、产品与当前状态

系统把商品标题中的容量、重量和数量结构化，再由确定性程序计算可回放的单位价。当前聚焦山姆饮料数据与微信小程序。

当前已存在：

- 同构 core、共享 API 契约、D1 持久层与离线 eval
- Cloudflare Workers API
- Taro 微信小程序

## 二、当前数据流

```text
RawProduct(title, price, optional hints)
  ├─ tier1 规则解析（packages/core）
  ├─ tier2 LLM 补全（仅 apps/api，OpenRouter）
  └─ tier3 确定性计算（packages/core）
       ├─ per100ml 或 per100g
       ├─ formula
       └─ warnings

写入路径 → D1/Drizzle → product_raw/product/unit_price + taxonomy
读路径   → /rankings 全量快照 → miniapp 本地 cohort/search/page
即时比价 → /compute（结构化输入、无 AI、不写库）
```

AI 只理解规格，不计算价格、不选择单位价结果。

## 三、仓库布局

```text
packages/core        # parser、units、calculator、领域 Zod schema
packages/api-client  # API Zod schema、URL、快照派生
packages/db          # D1/SQLite schema、repository、migration、taxonomy seed
packages/eval        # 标注语料与回归指标
apps/api             # Hono Worker、LLM、治理、路由
apps/miniapp         # Taro/React 微信小程序
docs                 # 架构、产品和运维文档
openspec             # 主 specs 与归档记录
```

## 四、packages/core

当前能力：

- `RawProduct` / `ParsedSpec` / `UnitPrice` 等 Zod schema
- `ml/L/g/kg` 归一化与别名
- tier1 规则解析和证据
- 容量轴 `per100ml`、重量轴 `per100g` 确定性计算
- formula、warnings 与轴互斥校验
- taxonomy 的 comparable-unit/tag-source 基础类型

当前**没有**独立 `comparable`、`excludedReason`、`comparisonGroup` 字段，也没有 CategoryPlugin 扩展体系。不可计算项以 `per100ml = per100g = formula = null` 和 warnings 表达。

## 五、apps/api

框架：Hono；生产运行时：Cloudflare Workers；数据库：D1(SQLite)+Drizzle；LLM：OpenRouter。当前没有解析缓存。

架构上把端点分成四类：可缓存公共读、无状态即时计算、受公共治理的解析/写入、独立鉴权的 admin 运维。完整路由、错误码、治理、secret 与部署命令只在 [`apps/api/README.md`](../apps/api/README.md) 维护。

## 六、apps/miniapp

当前客户端为 React 18.3.1 + Taro 4.2.1。它一次读取榜单快照并在本地派生 cohort/search/page，结构化即时比价由 API 计算；端上不运行 core，也不写中心库。具体页面、已实现状态与后续路线只在 [`miniapp-roadmap.md`](miniapp-roadmap.md) 维护。

## 七、持久层与 taxonomy

D1/SQLite 的表、迁移和运行时差异以 [`packages/db/README.md`](../packages/db/README.md) 为准；品类树、闭包、store-map 与打标签仲裁由共享 schema、repository 和回归测试共同锁定。

跨层关键边界只有一条：core 与持久层已支持重量轴，但当前 rankings 快照只传输 `rankable=true ∧ per100ml IS NOT NULL` 的容量轴行。

## 八、缓存与发布

- `/rankings`、`/categories` 成功响应走国内 CDN 长 TTL
- `/rankings` query 在边缘归一化为单缓存对象
- 数据或响应形状变更后按 purge → 归一化 → 预热 → 国内验形执行
- 小程序另有经 Zod jitless 重校验的 SWR 快照缓存
- Taro 构建前检查 React peer；Dependabot 不发 React 生态 major

## 九、合规边界

| 数据来源 | 当前态度 |
| --- | --- |
| 用户/运营主动提交当前商品 | 允许 |
| 小程序即时结构化比价 | 允许、无状态 |
| 浏览器读取用户当前页面 | 未来候选 |
| App MITM | 未来个人使用层 |
| 服务端主动全站爬取 | 不做 |

生产中心库只沉淀主动提交的数据。HAR/抓包仅作为受控运营或个人采集输入，不是服务端爬虫。

## 十、后续方向

近期：价格重抽节奏、详情/纠错/贡献闭环。发布平台的审核/上架状态不在仓库文档维护。

有明确消费者后再做：多商品 `/compare`、解析缓存、第三方 API 开放。

长期候选：浏览器插件、多商店、图片管线、纸品/洗护/肉类、Surge。任何候选都需独立 OpenSpec，不在目录存在前写成现状。
