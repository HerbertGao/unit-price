# 小程序改造路线图 ——「Sams值不值」

> 派生自 [`miniapp-product-form.md`](miniapp-product-form.md)(形态 SOT)。本文把「浏览优先 3-Tab 比价小程序」的改造拆成尽可能精细、可独立交付/验证的多期;每期对应一个 OpenSpec 提案(按项目惯例:先 `/openspec-propose` 再实现)。机制细节(品类树/标签/对比组)仍以 [`taxonomy-and-tagging.md`](taxonomy-and-tagging.md) 为准,不在此复制。

**产品定名**:`Sams值不值`(价格透视眼 / 拆超市数学障眼法)。
**起点**:现状为单页只读榜单(Taro+React,消费 `GET /rankings`)。
**长杆**:国内可达 + ICP 备案域名;标 **[域名前]** 的期可在微信 devtools + dev-API 内完整验证,**[域名后]** 的期需 ICP 落地。

---

## 一、分期总览

| 期 | 名称 | 类型 | 依赖 | 域名 | 建议提案名 |
|---|---|---|---|---|---|
| **P0** | 设计基线 + 品牌(frontend-design) | 设计 | — | 前 | (非 OpenSpec,产出设计系统) |
| **P1** | 端骨架:3-Tab + 榜单首页改造 | 端 | P0 | 前 | `add-miniapp-3tab-shell` |
| **P2** | Taxonomy v1 基建(打标签/树/闭包) | 后端 | — | 前 | `add-taxonomy-v1` |
| **P3** | 品类树榜 API + 分类 Tab + 属性筛选 | 后端+端 | P1,P2 | 前 | `add-category-tree-rankings` |
| **P4** | 品名搜索 API + 端搜索(命中/部分/未命中) | 后端+端 | P1,P2 | 前 | `add-product-search` |
| **P5** | 详情页 + 同品类比价 + 低样本诚实 | 后端+端 | P1,P3 | 前 | `add-product-detail-comparison` |
| **P6** | on-demand 兜底 + 贡献(我的 Tab) | 端+契约 | P1(P4 接入未命中) | 前 | `add-ondemand-contribute` |
| **P7** | 商品图管线(R2)+ 端渲染 + 总开关 | 后端+端 | P1(图槽),P5 | 前(大陆出图需域名) | `add-product-images-r2` |
| **P8** | 价格新鲜度展示 + 重抽刷新运营闭环 | 后端+端+运营 | P1 | 前 | `add-price-freshness` |
| **P9** | 分发上线:ICP 域名 + 真机 + 上架 | 配置+运营 | ~全部 | **后** | `public-launch-icp` |

**并行关系**:P2(纯后端基建)可与 P1(纯端)并行;P0 须最先。P3/P4/P5 都依赖 P2 的标签数据。P7/P8 相对独立,可在 P1 后插队。P9 是上线闸门。

**frontend-design 的角色**:P0 用 `/frontend-design:frontend-design` 建立「Sams值不值」**设计系统 + 关键屏高保真稿**;此后每个端期(P1/P3/P4/P5/P6)**实现时对齐 P0 系统**,新屏可先用 frontend-design 出稿、再翻译成 Taro(WXML/WXSS)。设计稿是 web 原型,作**视觉规格**,不是最终小程序代码。

---

## 二、各期详情

### P0 — 设计基线 + 品牌(frontend-design)　[域名前]
- **目标**:确立「Sams值不值」的视觉语言与可复用组件,让后续所有端期照着实现、不各画各的。
- **范围**:
  - 品牌:名称呈现、tone(可信 + 一点反套路俏皮)、主色/强调色、icon 思路(价格透视眼)。
  - 设计 tokens:色板(在现有 `#f5f6f7/#1f2329/#8a8f99/#2b6cf0` 基础上系统化)、字阶、间距、圆角、阴影、rpx 规范。
  - 核心组件:底部 TabBar、顶部搜索栏、榜单行/卡片、rank 徽标、**per100ml 大字**、整件价、attribute chip、品类树左栏/右栏、加载/空/错三态、**诚实标注族**(warnings chip、样本量提示、`采集于X月X日`/`可能已变动` 陈旧标、`暂不支持横向对比` 标、`comparable=false` 说明)、商品图占位与**缺图降级**(文字优先)样式。
  - 高保真稿:榜单首页、分类树、详情页、我的(4 屏)。
- **交付/验收**:✅ 已产出于 `design/sams-zhibuzhi/`(`index.html` 高保真原型 + `preview.jpeg`)。**主色定为山姆 App 蓝 `#014B90`**;配色 = 冷灰底 + 白卡 + 山姆蓝主结构 + 绿(值)/红(贵)/铜金(点缀),**单价数字保持中性墨色**;概念「诚实验货单」(算式当收据印出、诚实标注做成盖戳)。字体 Fraunces(标题)+ DM Mono(单价/公式)+ Noto Sans SC。作为后续端期视觉 SOT。
- **注**:产出是设计资产,不走 OpenSpec;但「缺图降级到文字优先」是 §十三 护栏的视觉前置,必须在此定样。

### P1 — 端骨架:3-Tab + 榜单首页改造　[域名前]
- **目标**:把单页小程序升级为 3-Tab 外壳,并把榜单首页按 P0 改造好看;**只用现有 `/rankings`**、不依赖新后端,立刻产出可见产品。
- **范围**:
  - `app.config.ts`:`tabBar` = 榜单 / 分类 / 我的;`navigationBarTitleText` → `Sams值不值`;新增页面路由。
  - 设计落地:`app.css` 写入 P0 tokens;抽出共享组件(行/卡片/chip/三态/TabBar 图标)。
  - 榜单首页:顶部搜索入口(跳搜索页,P4 前可为占位/禁用态)、旗舰「软饮真实单价榜·元/100ml」、rank 徽标、per100ml 大字、整件价;保留下拉刷新 + 触底分页 + 三态 + 降级广告位。
  - attribute chips:**展示但禁用/占位**(P3 接 API 后启用)。
  - 分类 / 我的:按 P0 出**带设计的占位**(「敬请期待」,非白屏)。
- **依赖**:P0。**无新后端**。
- **交付/验收**:devtools 三 Tab 可切;榜单首页对 dev `/rankings` 渲染新视觉;三态/分页/广告位回归通过。

### P2 — Taxonomy v1 基建　[域名前]
- **目标**:落地 `taxonomy-and-tagging.md` v1 的标签/树/闭包与打标签管线;为浏览/搜索/比价提供数据底座。**用户侧暂无可见变化**。
- **范围**:
  - schema:`tag`(kind + parent_id is-a + comparable_unit)、`product_tag`(只挂叶/原子标签)、`store_category_map`、`category_closure`;`product.pending_category_tag_id` + `rankable`。
  - seed 规范树:饮料→软饮→{碳酸/果汁植物饮/咖啡茶饮/饮用水} + 酒类(rankable=false);受控 attribute 值(无糖/气泡/进口…)。
  - 打标签管线:tier1 关键词规则(确定性、只产叶)+ 山姆 native 分类映射 + 仲裁;对**现有 329+ 商品 backfill** 打标签 + 补闭包。
  - (可选)debug 端点查看某商品的标签/归属,便于验证。
- **依赖**:无(可与 P1 并行)。
- **交付/验收**:现有商品获得叶品类 + 属性标签;`category_closure` 填充;归属冲突按规则可解释;不可判定项落 `待人工` 而非乱归。

### P3 — 品类树榜 API + 分类 Tab + 属性筛选　[域名前]
- **目标**:把扁平 `/rankings` 泛化为「按品类节点取榜」,并上线分类树浏览 + 属性筛选。
- **范围**:
  - API(契约入 `@unit-price/api-client`):
    - `GET /categories` → is-a 树 + 各节点 `rankable`/继承单位;
    - `GET /rankings?category=<节点>&attr=<无糖,…>` → cohort = 节点闭包 ∧ attribute,按继承 `comparable_unit` 升序(沿用 rankings-api 的只读/不重算/分页纪律)。
  - 端:分类 Tab(左栏 is-a 树 + 右栏 ranked cohort);attribute chips 在分类页与榜单首页**启用**(动态复合查询);不可排名节点显示「暂不支持横向对比」(可点进看列表、无单价排序)。
- **依赖**:P2(标签数据)、P1/P0(端与视觉)。
- **交付/验收**:浏览树→选节点出 ranked cohort;无糖/气泡 chip 即时重排;酒类等显示为不排名;分页稳定。

### P4 — 品名搜索 API + 端搜索　[域名前]
- **目标**:给用户可搜索空间;并把「目录不全」做成优雅降级而非死胡同。
- **范围**:
  - API:`GET /search?q=` → 解析品名/品牌/品名系列/品类 + 复合查询(如 `无糖可乐`),返回 ranked cohort 行;记录**未命中查询词**作需求信号(后端日志/表)。
  - 端:顶部搜索栏 → 搜索页。**命中**=ranked 行;**部分命中**=「找到山姆 N 件,其他门店暂未收录」;**未命中**=① 推荐最近 cohort ② on-demand 兜底入口(链到 P6)③ 记 miss。
- **依赖**:P2、P1。
- **交付/验收**:命中/部分/未命中三路径均有明确 UI;未命中不空结果、不报错。

### P5 — 详情页 + 同品类比价 + 低样本诚实　[域名前]
- **目标**:点进单品看真实单价 + 同品类排名,且低样本下仍可信。
- **范围**:
  - API(契约入 api-client):`GET /products/:id` 详情 + 其叶 cohort peers(复用 P3 cohort 查询)。
  - 端(§七):商品图槽(P7 前空)、名称/规格、**per100ml 大字**、货架价(参考)、**可回放 formula 直接展示**、同品类 cohort 排名(本品高亮 + attribute chip 收窄)、**低样本诚实**(「共收录 N 件,样本较少,仅供参考」)、**warnings chip**(如「数量按单件推断为1」,不展示 confidence)、**comparable=false** → 展示 `excludedReason` 并排除出排序。
- **依赖**:P3(cohort 查询)、P1。
- **交付/验收**:行→详情;cohort 排名 + 诚实标注族齐全;不可比项专业展示而非塞进榜。

### P6 — on-demand 兜底 + 贡献(我的 Tab)　[域名前]
- **目标**:让 on-demand `/parse` 在浏览优先形态下作搜索兜底 + 贡献入口落地;充实「我的」。
- **范围**:
  - 契约:把 `/parse`、`/contribute` 契约补进 api-client(现仅在 apps/api)。
  - 端「我的」:粘标题+价 → core tier1 即时算 per100ml + 展示 formula →「收录到榜单」调 `/contribute`;同一流从 P4 未命中入口可达。另:收藏、纠错入口(`/corrections`)、「我们怎么算单价」方法说明(信任叙事)。
- **依赖**:P1(壳);未命中入口接 P4。
- **交付/验收**:粘贴流即时算 + 可收录;搜索未命中能跳到此;方法说明就位。

### P7 — 商品图管线(R2)+ 端渲染 + 总开关　[域名前;大陆出图需域名]
- **目标**:按 §十三 自托管**列表单图**(只列表缩略、不做详情图),且风险可控。
- **范围**:
  - 后端:ingest 侧加图片步骤——从列表接口 `image` 拉 `?imageMogr2/thumbnail/!…` 缩略 → `put` R2(key `goods/{goodsId}.jpg`)→ 经 Worker 路由/自定义域从 **ICP 域名**提供(CDN 缓存);存 provenance(来源 URL/商店/采集时间)。
  - **护栏(硬性)**:服务端**总开关**(可一键全局关图)+ 图**非承载**(`image`/`imageKey` 在 schema/API/端全程可空可关)+ **通知-删除**(按图/品牌单点下架)。
  - 契约/端:rankings item & product detail 加可空 `imageKey`;榜单行/分类 cohort/详情顶部渲染缩略图,**缺图/关图时降级回 P0 文字优先**、不跳版。
- **依赖**:P1(图槽)、P5(详情图位)、ingest。
- **交付/验收**:图从 R2 经(dev/ICP)域名渲染;翻总开关→秒回文字优先、UI 不破;provenance 可按图删除。

### P8 — 价格新鲜度展示 + 重抽刷新运营闭环　[域名前]
- **目标**:落实「仅标注陈旧」策略(不先建价格刷新),并把运营重抽固化为流程。
- **范围**:
  - 端:每条带「采集于 X月X日」(取 `product_raw` 采集时间;若无可用字段,这是一处小 schema/ingest 增项);超阈(初版 30 天,可调)打「可能已变动」+ 排序降权;榜单首页**新鲜度/范围诚实横幅**(「含山姆软饮 N 件·更新于 X月X日·酒类暂不参与排名」)。
  - 运营:软饮**定期 HAR 重抽 → ingest 刷新价格/纳入新上架**的 runbook(软饮已全量,不为广度补抓)。
  - (可选,非本期)价格刷新 upsert 能力 = 已知延后项。
- **依赖**:P1。
- **交付/验收**:陈旧标 + 横幅渲染;运营 runbook 成文。

### P9 — 分发上线:ICP 域名 + 真机 + 上架　[域名后]
- **目标**:把前面全部成果送达真实用户。
- **范围**:ICP 备案 + 国内可达域名落地(API、图床同域);小程序/Worker 指向新域名;真机预览 → 提交审核 → 上架;开真实流量 → 众包 trickle 启动 → 开始观测(查询完成率、贡献产出、回访)。
- **依赖**:~全部期 + ICP(日历时间,**Day-1 并行启动备案**)。
- **交付/验收**:大陆真机可达可用;上架通过;真实流量回流。

---

## 三、执行约定

- 每期开工前 `/openspec-propose` 出单期提案(聚焦单能力),实现后归档。
- 新对外契约一律先进 `@unit-price/api-client`(端消费预构建 dist),不在端手写重复类型。
- 守不可动摇约定:三段式解析、AI 只理解不计算、计算留痕 formula、Zod schema 单一事实源、core 纯函数无 IO。
- §十三 商品图护栏(总开关/图非承载/通知-删除/只缩略/限软饮)**不可在后续期被悄悄削弱**。
