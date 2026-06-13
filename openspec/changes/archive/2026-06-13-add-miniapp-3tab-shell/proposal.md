## 为什么

现有小程序是**单页只读榜单骨架**,作为完整比价产品不够格:没有可回访的结构、视觉粗糙、缺分类 / 搜索 / 我的入口。按 `docs/miniapp-roadmap.md` 的 **P1**,把它升级为 **3-Tab 外壳**,并按 P0 设计基线(`design/sams-zhibuzhi/`,山姆蓝主题 + 「诚实验货单」概念)改造榜单首页。本期**只消费现有 `GET /rankings`、不引入任何新后端**,是最快、零后端依赖的可见落地,为 P2+ 的品类树 / 搜索 / 详情铺好骨架与视觉语言。

## 变更内容

- 把 `apps/miniapp` 从单页升级为 **3 个底部 Tab**:榜单(首页)/ 分类 / 我的;`navigationBarTitleText` → `Sams值不值`。
- 榜单首页按 P0 设计基线重做视觉:品牌头、顶部搜索入口、**静态范围说明条**(本期不含动态件数 / 采集日期)、attribute chips、rank 徽标、**per100ml 大字**、整件价;**保留**下拉刷新 + 触底分页 + 加载/空/错三态 + 降级广告位。
- `app.css` 落地 P0 设计 tokens(色板含山姆蓝 `#014B90`、字阶、间距、圆角、阴影);抽出共享组件(榜单行 / 卡片 / chip / 三态;原生 tabBar 为 `app.config` 配置 + PNG 图标、非 React 组件,不在此列)。
- 顶部搜索入口与 attribute chips 本期为**占位 / 禁用态**(分别待 P4 搜索、P3 属性筛选接入),**不发起任何请求**。
- 分类 / 我的 两个 Tab 本期为**带设计的占位页**(「敬请期待」,非白屏)。
- **不引入任何新后端 / 新 API / 新契约**;仍只消费现有 `GET /rankings`,保持只读边界(无录入 / 扫码 / 拍照、无端上 tier1 / 计算)。

## 功能 (Capabilities)

### 新增功能
<!-- 无新增能力:P1 全部落在既有 miniapp 能力内。 -->

### 修改功能
- `miniapp`: 由「单页只读榜单骨架」扩展为「**3-Tab 只读骨架**」。本 delta = **MODIFIED**「只读骨架」需求(含 3-Tab + 只读边界细化)+ 3 个 **ADDED** 需求(P0 设计基线落地 / 搜索·chips 占位不发请求 / 分类·我的 占位页)。既有「一屏分页与三态」「列表内降级广告位」两需求**行为不变、不进本 delta**(OpenSpec sync 时原样保留),仅迁移实现载体,其回归由 tasks 第 5 组**逐场景**保障。

## 非目标

- 不做品类树 / 属性筛选的真实数据(P3)、搜索功能(P4)、详情页(P5)、on-demand / 贡献 / 纠错(`/corrections`)(P6)、商品图(P7);`我的` 仅占位、不含任何写路径入口。
- **范围说明条本期为静态**:真实新鲜度(件数 N / 采集日期)属 P8、品类范围属 P3;本期**禁止**展示动态 N / 日期(`/rankings` 无该字段,避免伪诚实横幅),也**不**为此加新契约字段。
- 不引入新后端、新 API、新 `@unit-price/api-client` 契约;不改 `GET /rankings`。
- 搜索入口与 attribute chips **仅占位**,本期不发起任何网络请求、不做任何端上计算。
- 不触碰合规敏感面:无抓取、无众包写入——纯读、纯端、纯视觉。

## 影响

- **`apps/miniapp`**(唯一受影响应用):
  - `src/app.config.ts`:新增 `tabBar`(榜单 / 分类 / 我的)、`pages`(新增分类 / 我的)、`navigationBarTitleText`。
  - `src/app.css`:写入 P0 设计 tokens。
  - 新增 `pages/category`、`pages/mine` 占位页;`pages/index`(榜单首页)按 P0 重写 + 抽共享组件(`components/`)。
  - 沿用现状:miniapp **不进**根 `tsconfig.json` 的 `tsc -b` references(Taro 自管构建);继续消费 `@unit-price/api-client` 预构建 dist 的 `buildRankingsUrl` / `parseRankingsResponse`(含既有 jitless Zod 解析,见运行时约定)。
- **不影响** `packages/*` 与 `apps/api`:无新契约、无 schema 改动、无后端改动。
- **合规面**:无——纯读、无写、无新数据源。
