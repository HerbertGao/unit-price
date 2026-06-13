# 实现任务 — P1 · add-miniapp-3tab-shell

> 范围:仅 `apps/miniapp`。无新后端 / 新契约;沿用 `@unit-price/api-client` 现有 `buildRankingsUrl` / `parseRankingsResponse`(jitless)。视觉对照 `design/sams-zhibuzhi/index.html`。

## 1. 设计 tokens 与基础样式 (apps/miniapp/src/app.css)

- [x] 1.1 把 P0 设计 tokens 写入 `src/app.css` 为 CSS 变量,**值取自 `design/sams-zhibuzhi/index.html` 的 `:root`、不得复用旧 `index.css` 占位色**:`--paper:#F1F3F6` / `--paper-card:#FFFFFF` / `--paper-sink:#E9EDF2` / `--ink:#1B2735` / `--ink-soft:#54606E` / `--muted:#8B95A2` / `--line:#E4E8ED` / `--blue:#014B90` / `--worth:#137A4C` / `--pricey:#DE1C24`,加字阶 / 间距 / 圆角、阴影 token `--shadow`(其值含一处 `rgba(...)`,位于 app.css token 定义处、为 5.4 grep 唯一合法 rgba 来源);px→rpx 换算(约 1px≈2rpx)。**凡 P0 榜单首页与本期抽出组件(chip / 三态 / 榜单行含 top 态 / 标注标)实际用到的 `:root` 色板 token 均须一并落入 app.css**(含 `--line-strong` / `--blue-bg` / `--worth-bg` / `--pricey-bg` 等,不限于上列);**排除**本期屏内不出现的色(`--board-*` / `--em` / `--blue-bright` / `--stamp` / `--gold`——`--gold` 属 P5 详情 / P6 / P8 陈旧标)与示意插画色(如瓶子渐变)
- [x] 1.2 定义字体栈(系统中文栈 + 等宽兜底)与 `per100ml` 大字规格(字号 / 字重 / 紧字距,D1);**禁止**依赖远程网络字体
- [x] 1.3 将 `pages/index/index.css` 的旧硬编码色(`#f5f6f7 / #1f2329 / #8a8f99 / #2b6cf0 / #ffffff` 全部)**替换为 `app.css` CSS 变量引用并删除散写**(旧主操作蓝 `#2b6cf0` → `var(--blue)`、白 `#ffffff` → `var(--paper-card)`),使 `index.css` **不再含任何十六进制颜色字面量**;但**保留** `.ad-slot--empty { height:0 … }` 等**布局规则**(仅替换其中颜色、布局不动)。注:`AdSlot` 内联 style 仅布局值(`height:0` 等,**load-bearing、保持不动**),无颜色需清理。色值仅允许在 `app.css` token 定义处(`app.config.ts` / 各页 `*.config.ts` 原生配置色字段除外,见 5.4)

## 2. 3-Tab 外壳 (apps/miniapp)

- [x] 2.1 制作 3 个 Tab 的 PNG 图标(按 P0 设计语言新制线性图标,或选用通用线性图标库;统一尺寸如 81×81、未选中 + 选中两态,选中色山姆蓝 `#014B90`),放入 `src/assets/`(D2)
- [x] 2.2 改 `src/app.config.ts`:新增 `tabBar`(3 项)、`pages`(新增 `pages/category/index`、`pages/mine/index`)、`navigationBarTitleText` 由 `单价榜单` 改为 `Sams值不值`;**保留** `lazyCodeLoading:'requiredComponents'`(抽组件后于 devtools 验证各页组件按需注入正常)
- [x] 2.3 新建 `pages/category`(分类)带 P0 设计的占位页:「敬请期待」、非白屏、**不发任何请求**
- [x] 2.4 新建 `pages/mine`(我的)带 P0 设计的占位页:非白屏、**禁止**出现贡献 / 录入 / 纠错(`/corrections`)/ 扫码 / 拍照入口
- [x] 2.5 删除 / 改 `pages/index/index.config.ts` 的 `navigationBarTitleText`(现为 `单价榜单`),令榜单首页导航栏继承 app 级 `Sams值不值`(或与品牌常量共用)——**避免页面级配置覆盖 app 级标题**;新建的 `pages/category` / `pages/mine` 的 `*.config.ts` 同样**不写页面级 `navigationBarTitleText`**(一律继承 app 级 `Sams值不值`),统一标题来源

## 3. 共享组件抽取 (apps/miniapp/src/components)

- [x] 3.1 抽 `RankingRow` 组件(rank 徽标 / `per100ml` 大字 / 整件价 / 标注 chip 槽),消费 app.css tokens
- [x] 3.2 把三态(加载 / 空 / 首屏错 / 翻页错)与列表 footer 的**呈现**抽为 props 驱动的纯展示组件(状态由页面 / `useRankings` 判定后传入);**状态机与 Taro 生命周期钩子留在页面、不下沉组件**(D4)
- [x] 3.3 抽 品牌头 / 顶部搜索入口 / **静态范围说明条** / attribute chip 组件(占位态)
- [x] 3.4 适配既有 `AdSlot` 到新行结构(保持 rank 10/22/34… 后插入、v1 零高度降级);`adSlots.ts` 维持在 `pages/index/`(其单测 `./adSlots` 相对引用不变),若随组件移动须同步改 test import

## 4. 榜单首页重做 (apps/miniapp/pages/index)

- [x] 4.1 用新组件重写 `index.tsx` 布局:品牌头 + 搜索入口 + **静态范围说明条** + chips 区 + 榜单列表;品牌串 `Sams值不值` 定义为单一常量、与 `navigationBarTitleText` 共用
- [x] 4.2 接入既有 `useRankings` + `buildRankingsUrl` / `parseRankingsResponse`(jitless),保留下拉刷新 + 触底分页 + 三态(D4);**保留既有首屏错态(整屏错 + 重试)与既有文案、不改 `useRankings` 的错误判定**(不在本期透传具体错误、以免改 hook 越范围;`BASE 未配置` 为占位未填时防御分支,当前已填、不触发)
- [x] 4.3 attribute chips 渲染为占位 / 禁用态,点击**不发请求、不重排**(spec)
- [x] 4.4 顶部搜索入口点击 = 「敬请期待」轻提示(toast,**不新建独立搜索页**),**不发请求、不构成录入路径**(spec);可沿用 P0 原型的 placeholder 外观,但点击只触发 toast、**不进入输入 / 聚焦态**;搜索图标(放大镜)描边用 `currentColor`(继承 `var(--muted)`)或 token,**不得内联 hex**(避免触发 5.4)

## 5. 验证 (微信 devtools + dev-API)

- [x] 5.1 三 Tab 可切、各 Tab 非白屏;**切换三 Tab 时导航栏标题始终为 `Sams值不值`**(无页面级覆盖);榜单首页元素齐全(品牌头 / 搜索 / **静态范围说明条(无动态 N·日期)** / chips / 列表行含 rank·per100ml 大字·整件价)
- [x] 5.2 回归(逐场景对照既有 miniapp spec):下拉刷新 `offset=0` 替换;触底 `offset+=limit` 追加、少于 limit(含空)即停;首屏错 = 整屏错 + 重试(不白屏 / 不渲染未校验);翻页错 = 保留列表 + 局部重试(不清空回退整屏);空态非白屏;广告位前 10 条零 DOM、第 10 条后插入点(10/22/34…)、v1 wrapper `height===0` 不跳版
- [x] 5.3 只读边界核查:全局仅 `/rankings` 请求;无录入 / 扫码 / 拍照 / 贡献 / 纠错入口;chips 与搜索入口不触网
- [x] 5.4 token 核查(机械):`grep` `apps/miniapp/src` 的 **`pages/**` 与 `components/**`**(**不扫 `app.css` 自身**——它是 token 定义处)下的 `.css` 与组件内联 `style`,**无任何颜色字面量**(hex / `rgb(a)` / `hsl(a)` / 具象命名色,**不含** `transparent` / `inherit` / `currentColor`;阴影走 `var(--shadow)`、不得直写 `rgba(...)`),一律 `var(--…)`,色值仅存在于 `app.css` token 定义处;**例外**:`app.config.ts` / 各页 `*.config.ts` 原生配色字段与 tabBar PNG——其中 tabBar `selectedColor` = `--blue` `#014B90`、其余按 P0 取**对应** token 同值(navbar 背景=`--paper`、未选中=`--muted`、tabBar 底=`--paper-card`),不计入本 grep;口径核查:可比量用 `per100ml`、未用整件价反推
- [x] 5.5 构建核查:miniapp 不在根 `tsc -b` references;api-client/core 先构建、Taro build 正常;jitless Zod 解析无回归(无假 timeout)
- [x] 5.6 既有单测仍绿:**直接执行** `adSlots.test.ts`(如 `pnpm --filter @unit-price/miniapp exec vitest run src/pages/index/adSlots.test.ts`,**不依赖 `--passWithNoTests`**,确保测试文件存在且真跑);若 `RankingRow` 抽离改了广告位插入点引用,则更新 / 补测
