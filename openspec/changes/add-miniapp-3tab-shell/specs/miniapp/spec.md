## MODIFIED Requirements

### 需求:miniapp 必须是消费 /rankings 的只读榜单小程序骨架

`apps/miniapp`(`@unit-price/miniapp`)**必须**是一个 Taro(React + TS)微信小程序工程,定位为**只读骨架**:采用 **3 个底部 Tab**——**榜单(首页)/ 分类 / 我的**,其中**榜单为首页 Tab**、承载真实单价榜浏览。`navigationBarTitleText` **必须**为 `Sams值不值`。

整体仍为**只读浏览**:**禁止**包含录入 / 扫码 / 拍照路径,**禁止**在端上跑 tier1 解析或单价计算(只读已算好的 `/rankings` 数据)。本期顶部搜索入口仅为**点击 toast 占位提示(不跳页)**、`我的` Tab 仅为占位页(见下),二者**均不构成录入路径、且不发起任何网络请求**。榜单数据**必须**通过 `@unit-price/api-client`(`buildRankingsUrl` + `parseRankingsResponse`)消费 `GET /rankings`,网络层用 `Taro.request`(api-client 传输无关,发请求在本端)。

**构建集成**:`apps/miniapp` 是 pnpm workspace 成员(deps 走 `workspace:*`),但**必须不进**根 `tsconfig.json` 的 `tsc -b` references——由 `@tarojs/cli` 自管构建,消费 `@unit-price/api-client` 的**预构建 dist**。api-client/core **必须**先于 Taro 打包构建(构建顺序)。

#### 场景:只读、不含录入与计算
- **当** 检查 `apps/miniapp` 源码
- **那么** **禁止**出现录入 / 扫码 / 拍照入口,**禁止**引入 `packages/core` 的 tier1/calculator 做端上计算;榜单数据**必须**来自 `/rankings`(已算好的 per100ml)

#### 场景:三个底部 Tab 且只读边界不变
- **当** 进入小程序
- **那么** **必须**有 3 个底部 Tab(榜单 / 分类 / 我的),榜单为首页;切换 Tab 不破坏只读边界——本期 `分类` / `我的` / 顶部搜索入口 / attribute chips **禁止**发起**任何**网络请求(`/rankings` 仅由榜单首页发起),**禁止**包含录入 / 扫码 / 拍照 / 贡献 / 纠错入口

#### 场景:经 api-client 消费 /rankings
- **当** 小程序请求榜单
- **那么** **必须**用 `@unit-price/api-client` 的 `buildRankingsUrl` 构造 URL、`Taro.request` 发请求、`parseRankingsResponse` 校验响应;**禁止**在 miniapp 内手写重复的响应类型或绕过校验

#### 场景:miniapp 不进根 tsc -b reference 图
- **当** 检查根 `tsconfig.json` 的 references
- **那么** **必须不含** `apps/miniapp`(Taro 自管构建);miniapp 消费 api-client 的预构建 dist,api-client/core 先于 Taro 打包构建

## ADDED Requirements

### 需求:榜单首页必须按 P0 设计基线呈现并落地共享设计 tokens

榜单首页(榜单 Tab)**必须**按 P0 设计基线(`design/sams-zhibuzhi/`,主色山姆蓝 `#014B90`、「诚实验货单」概念)实现视觉。设计 tokens(色板、字阶、间距、圆角、阴影)**必须**集中落地于 `app.css`;**禁止**在页面 / 组件的 css 或内联 style 散写任何色板十六进制字面量(含**清理**既有 `pages/index/index.css` 的旧硬编码色),页面 / 组件只能引用 CSS 变量(`var(--…)`);复用的 UI(榜单行卡片 / chip / 加载·空·错三态)**必须**抽成共享组件供后续端期(P3+)复用(原生 `tabBar` 是 `app.config` 配置 + PNG 图标资产,非 React 组件、不在此列)。

榜单首页**必须**至少呈现以下元素:品牌头(`Sams值不值`)、顶部搜索入口、**静态范围说明条**、attribute chips 区、以及榜单列表(每行含 rank 徽标、`per100ml` 大字、整件价)。**范围说明条本期为静态**:只声明榜单范围与单位口径(如「山姆软饮真实单价榜 · 元/100ml」;此为静态运营声明,不声称端上已做品类过滤——品类真实过滤属 P3;范围话术须与 `/rankings` v1 实际数据口径一致——v1 入榜 = `per100ml` 非空,即山姆软饮),**禁止**呈现动态件数 N 或「更新于 X月X日」采集日期——`/rankings` 现无件数 / 采集时间字段,真实新鲜度横幅属 P8、品类范围属 P3,本期提前展示动态值即伪诚实。本需求约束「呈现哪些元素 + tokens 集中化」,不约束像素级审美。

#### 场景:首页视觉元素齐全
- **当** 进入榜单 Tab
- **那么** **必须**可见:品牌头 `Sams值不值`、顶部搜索入口、**静态范围说明条**、attribute chips 区、以及榜单列表(每行含 rank 徽标 / `per100ml` 大字 / 整件价);范围说明条**禁止**出现动态件数 N 或采集日期

#### 场景:设计 tokens 集中(机械可验:页面 css 零颜色字面量)
- **当** 对 `apps/miniapp/src` 的 **`pages/**` 与 `components/**` 下的 `.css` 与组件 JSX 内联 `style`**(**不扫 `app.css` 自身**——它是 token 定义处、允许出现色值)`grep` 任意颜色字面量(`#` 3/6/8 位 hex、`rgb()` / `rgba()`、`hsl()` / `hsla()`、具象命名色)
- **那么** 页面 / 组件的 css 与内联 style **禁止出现任何**颜色字面量(hex / rgb(a) / hsl(a) / 具象命名色;**不含** `transparent` / `inherit` / `currentColor` 等功能性关键字)——一律改用 `var(--…)`(含**阴影走 `var(--shadow)`**,不得直写 `rgba(...)`);颜色字面量**只允许**出现在 `app.css` 的 token 定义处(既有 `index.css` 的旧硬编码色**必须**已清理为变量引用)。**例外(不在本 grep 范围)**:`app.config.ts` 与各页 `*.config.ts` 的原生配置色字段(`window.navigationBarBackgroundColor`、`tabBar` 的 `color` / `selectedColor` / `backgroundColor`)、以及 tabBar PNG 图标——小程序框架限制、不能引 CSS 变量,故豁免;其中 tabBar **`selectedColor`(及选中图标烧入色)必须 = `--blue`(`#014B90`)**,其余原生配色字段按 P0 设计取**对应** token 同值(如导航栏背景取 `--paper` 同值、tabBar 未选中 `color` 取 `--muted` 同值、tabBar `backgroundColor` 取 `--paper-card` 同值),**不强制全部 = 蓝**

#### 场景:可比单价仍以 per100ml 呈现、不被整件价反推
- **当** 渲染榜单行
- **那么** 行内**必须**以服务端 `per100ml` 作为可比真值的大字呈现,整件价(`priceCents / 100`)仅作参考标价;**禁止**用整件价反推或替代 `per100ml`

### 需求:搜索入口与 attribute chips 本期为占位、不发起任何请求

顶部搜索入口与 attribute chips 在本期(P1)**必须**为占位 / 禁用态:它们的真实功能分别由 P4(搜索)、P3(属性筛选)交付。本期二者**禁止**发起任何网络请求、**禁止**做任何端上计算或重排数据。

#### 场景:搜索入口为占位提示、不请求
- **当** 用户点击顶部搜索入口
- **那么** **必须**仅给「敬请期待」轻提示(toast,本期**不新建**独立搜索页),**禁止**发起任何网络请求,**禁止**构成录入 / 扫码 / 拍照路径

#### 场景:attribute chips 占位、不重排不请求
- **当** 用户点击 attribute chip(无糖 / 气泡 / 进口 等)
- **那么** chip 处于占位 / 禁用态,**禁止**因此发起请求或在端上重排榜单;真实筛选留待 P3

### 需求:分类与我的为带设计的占位 Tab

`分类` 与 `我的` 两个 Tab 在本期**必须**为**带设计的占位页**(套用 P0 设计语言、显示「敬请期待」一类占位内容),**禁止**白屏。`我的` 占位页本期**禁止**出现贡献 / 录入 / 纠错的可用入口(保持只读边界;贡献入口留待 P6)。

#### 场景:占位页非白屏
- **当** 切换到 `分类` 或 `我的` Tab
- **那么** **必须**显示带 P0 设计的占位内容(非白屏、非报错)

#### 场景:我的占位不含贡献/录入/纠错
- **当** 检查 `我的` 占位页
- **那么** 本期**禁止**包含可用的贡献 / 录入 / 纠错(`/corrections`)/ 扫码 / 拍照入口
