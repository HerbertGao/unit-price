## 上下文

`apps/miniapp` 现为单页只读榜单(`pages/index`),通过 `@unit-price/api-client` 的 `buildRankingsUrl` / `parseRankingsResponse`(jitless Zod)消费 `GET /rankings`,具备下拉刷新 + 触底分页 + 三态 + 降级广告位。P1 在**不引入新后端 / 新契约**的前提下,把它升级为 3-Tab 外壳并按 P0 设计基线(`design/sams-zhibuzhi/index.html`,主色山姆蓝 `#014B90`)改造榜单首页。P0 产物是 **web 高保真原型**(px、Fraunces + DM Mono 网络字体),需翻译为 Taro 小程序实现(rpx、小程序字体约束)。

约束:① 保持只读边界(无录入 / 扫码 / 拍照 / 计算);② 不破坏既有 jitless Zod 运行时设置(见运行时约定 [[taro-weapp-modern-syntax-transpile]]:esbuild-vendor 保 Zod class + `parseRankingsResponse` 传 jitless);③ miniapp 不进根 `tsc -b` references。

## 目标 / 非目标

**目标:**
- 3 个底部 Tab(榜单 / 分类 / 我的),榜单为首页;`navigationBarTitleText = Sams值不值`。
- 榜单首页按 P0 视觉重做,设计 tokens 集中化,抽出可复用组件供 P3+ 用。
- 搜索入口 / attribute chips 占位(不发请求),分类 / 我的 带设计占位页。

**非目标:**
- 不做真实搜索 / 属性筛选 / 品类树 / 详情 / 贡献 / 商品图(P3–P7)。
- 不引入新后端、新 API、新 api-client 契约;不改 `/rankings`、不改 `packages/*` 与 `apps/api`。

## 决策

- **D1 字体:v1 用系统字体栈,不强加载 Fraunces / DM Mono。** P0 原型的网络字体在小程序里不可直接用(无可靠远程 `@font-face`);`wx.loadFontFace` 加载远程字体有延迟 / 失败风险且对首屏不友好。决策:v1 用系统中文栈 + 等宽兜底,`per100ml` 的「大字」效果由**字号 + 字重 + 紧字距**实现,而非依赖具体字形。**取舍**:与 web 原型字形有差异(原型字形为视觉示意、非硬规格)。替代:仅对数字用 `wx.loadFontFace` 加载 DM Mono——留待后续,不在 P1。
- **D2 TabBar:v1 用小程序原生 `tabBar`(app.config)+ 自绘 PNG 图标,不上自定义 tab-bar 组件。** 原生 tabBar 稳、零额外渲染风险;P0 的线性图标用导出的 PNG(选中 / 未选中两态)满足。**配色取值(app.config 字面量,与 app.css token 同值)**:`selectedColor`(及选中图标烧入色)= `--blue` `#014B90`;未选中 `color` = `--muted` 同值;`backgroundColor` = `--paper-card` 同值;`window.navigationBarBackgroundColor` = `--paper` 同值(**非全部刷蓝**——P0 导航栏为浅纸底、品牌蓝只用于前景与选中态)。**取舍**:原生 tabBar 样式可定制度有限(仅图标 / 文字色 / 背景)。替代:`custom: true` + 自定义 tab-bar 组件可完全还原 P0,但 weapp 自定义 tab-bar 有状态同步坑、成本高——若原生样式实测不达标再升级,不在 P1 默认路径。
- **D3 设计 tokens:落 `app.css` 的 CSS 变量(rpx),组件消费变量。** px→rpx 按约 1px≈2rpx 换算。主色等 token 集中定义,页面 / 组件**禁止**散写硬编码主色(对齐 spec 需求)。
- **D4 复用既有数据层,不重写状态机。** **数据层 `useRankings` 与 Taro 生命周期钩子(`useLoad` / `usePullDownRefresh` / `useReachBottom`)保持在 `pages/index`、不下沉组件**;并发守卫(`inFlightRef`)、首屏错 vs 翻页错区分、`reachedEnd` 判定均留在页面 / hook。仅把三态与列表 footer 的**呈现**抽为 props 驱动的纯展示组件(页面判定后传入 loading/empty/firstError/pageError/reachedEnd);`AdSlot` 仍按 `item.rank` 在页面插入。**禁止**把状态判定逻辑搬进展示组件(否则破坏并发守卫与首屏/翻页错区分)。
- **D5 占位即提示 / 静态,不发请求。** 搜索入口 = 「敬请期待」toast(**不新建独立搜索页**);chips = 禁用视觉;分类 / 我的 = 静态占位页。四者均不触网、不计算,保只读边界。
- **D6 范围说明条本期为静态、不展示动态新鲜度。** `/rankings` 契约(`@unit-price/api-client` 的 `RankingsItem`)**无件数 N、无采集日期**,本期又「不引入新契约」,故榜单首页范围条只放**静态范围话术**(如「山姆软饮真实单价榜 · 元/100ml」,为静态运营声明、不声称端上已做品类过滤——品类真实过滤属 P3),**禁止**动态 N / 「更新于 X月X日」。**取舍**:与 P0 原型里「收录 N 件 · 更新于 X月X日」示意有差(原型为视觉示意)。**替代均拒**:本期就上动态横幅 → 要么造假(违诚实内核 + 伪验收)、要么加新契约字段(违本期『无新契约』)。真实新鲜度横幅属 P8(需采集时间字段)、品类范围属 P3。

## 风险 / 权衡

- [字体差异:小程序无原型字形] → 用系统栈 + 字号字重还原层级;数字字形后续可选 `wx.loadFontFace`。
- [原生 tabBar 样式受限,可能不完全还原 P0] → v1 接受;若实测明显偏离再评估自定义 tab-bar(独立小变更)。
- [重构榜单首页可能回归既有三态 / 分页 / 广告位逻辑] → 逻辑保留、仅换展示层;对照既有 miniapp spec 的三态 / 分页 / 广告位场景回归验证。
- [破坏 jitless Zod / esbuild-vendor 设置导致假 timeout] → P1 不动 api-client 消费方式与构建配置;**抽组件不得新增触发转译的 npm 依赖**;若必须新增,按 [[taro-weapp-modern-syntax-transpile]] 处置并重验。
- [抽组件 + 现有 `lazyCodeLoading:'requiredComponents'` → 组件按需注入可能漏注入致运行时找不到] → **保留**该配置;抽组件后在 devtools 组件注入检查各页 `usingComponents` 正常。`navigationBarTitleText` 由现值 `单价榜单` 改为 `Sams值不值`。
- [首屏错态] → **保留既有首屏错态(整屏错 + 重试)与既有文案,不改 `useRankings` 的错误判定**;`BASE 未配置` 是 config 占位未填时的防御分支(当前 BASE 已填、不触发),本期**不要求**端上透传具体错误(透传需给 hook 加 `errorMessage` 字段,属 P1「只换展示层」范围外、不做)。

## 迁移计划

纯前端增量,无数据 / 契约 / 后端变更。回滚 = 还原 `apps/miniapp` 改动即可,不影响 `packages/*`、`apps/api`、线上 `/rankings`。验证在微信 devtools + dev-API 完成(对照 spec 场景),无需 ICP 域名。
