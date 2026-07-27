## 为什么

`saveParsed` 的去重键 `dedupe_key = rawId + 规范化 ParsedSpec` **与价格无关**,命中时走 first-write-wins(sqlite `onConflictDoNothing` / D1 SELECT-first)**直接返回既有 id 对、不写任何列**。于是同一 `(store, store_sku)` 重报新价时,`product_raw.price` / `captured_at` 被无条件覆盖(upsert 语义),而 `unit_price.per100ml` / `formula` 仍**冻结在首次观测的价格**上。榜单大字单价与排序读的正是这个冻结值。

生产实测(2026-07-27,全库 1297 raws / 1197 products / 507 rankable):

- **69 条偏差行**(`yuanToCents(formula 首项) ≠ product_raw.price`),其中 **44 条在榜**;
- 表现是同一行「整件 ¥89.90」配着按 ¥99.90 算出的每 100ml 大字,排序也按错值排;
- 本地对真实 repository 代码复现过:同款重报 22.8 → 22.5 后,`product_raw.price` 为 `2250` 而存储 `formula` 仍是 `22.8 / (300 * 24 * 1) * 100`。

这条 quirk 与刚上线的失效置灰**叠加成陷阱**:全库 **935/1297(72%)** 的 raw 已超 30 天阈值置灰(榜单口径 330/361);运营为解置灰去重抽 HAR 重灌,`captured_at` 会刷新、灰色消失,而 `per100ml` 依旧是旧价——**「诚实的过期」被换成「看起来新鲜的错价」**,比现状更坏。故重灌之前必须先合上这道闸。

## 变更内容

**只做一件事:把闸关上。**

- **`saveParsed` 去重命中时刷新既有 `unit_price`**:命中 `dedupe_key` 的分支不再只读返回,而是用**本次调用的 `calc`** 覆写既有行的 `per100ml` / `per100g` / `formula` / `confidence` / `warnings` 五列,再返回**既有(最老)** 的 `{productId, unitPriceId}`。id 幂等语义、`product` 行「保留最老一条」语义、`dedupe_key` 构造、`saveParsed` 签名**均不变**。
- 覆盖 sqlite 与 D1 **两条驱动路径的全部命中分支**(sqlite 事务内 `changes=0`、D1 SELECT-first 命中、D1 并发抢插失败后回退命中),三处共用同一**语句构造**函数(执行形态按驱动分叉),**禁止**只补一处造成驱动间行为漂移。
- **刷新是无条件写**,不加任何条件谓词(理由见 `design.md` D2)。写入值就是 `orchestrate` 已产出的 `calc`,与首插分支逐字同源——因此**没有** warnings 集合运算、没有影响行数判定、没有新的计算路径。
- **存量修正靠重灌,不靠新端点**:实测 69 条偏差行**全部不属幽灵类**(`drifted_ghost = 0`),关闸后预期由重灌覆盖;而 4 组幽灵行(同一 raw 挂多条 product)**一条都不偏差、且全不在 per100ml 榜上**。故本变更**不新增** admin 重算端点(理由与实测数见 `design.md` D3 与非目标)。
- **运维侧给一条逐行检测 SQL**(`yuanToCents(parseFloat(formula 首项)) === price`)写进 runbook:它是关于**存储状态**的判定器,命中即偏差;**不命中只在检测器覆盖集合内代表干净**(`formula IS NULL`、有 product 无 `unit_price`、有 raw 无 product 三类整类不可见,覆盖面见 `design.md` D3),与后台是否还在跑无关。循环 = 跑检测 → 对其中**可修**的那部分(排除幽灵 raw、且仍在本轮 HAR 里的)**经同步 `/contribute`** 重报 → 再跑,直到可修集为空;幽灵行作已披露残留登记。**「检测干净」只在关闸(暂停异步 ingest)之后才是持久结论,而关闸在重灌之后**——完成判据、覆盖面与该边界见 `design.md` D3。

## 功能 (Capabilities)

### 新增功能
<!-- 无新增独立能力:全部是既有能力的需求级修正。 -->

### 修改功能

- `persistence`: ①「product 必须按去重键收敛、相同结果只保留最老一条」——命中分支从「不写」改为「用本次 `calc` **无条件刷新** `unit_price` 五列」,把「保留最老」收窄为**只约束行与 id、不冻结派生值**,并承认刷新是新引入的失败面(`/contribute` 可 `500`、`/ingest` 后台只记日志)与「同步响应不是库内读回」;②「`product_raw` 必须维护历史最低价水位(`lowest_price`)」——只订正其失真的举例(硬约束不变)。
- `contribute-ingest`: ①「观测优先的两段落地」——补齐派生侧传导,把「禁止 raw 新价 / `unit_price` 旧价」写成**条件式**禁令 + 四个合法例外,并写明这四类的收敛动作是**再重报一次**、**禁止**声称自动自愈;②「后台解析失败只记日志且不重试」——`saveParsed` 抛错现有两种形态(首插失败 = 「有 raw 无 product」/ 刷新失败 = 「派生值落后」),。
- `rankings-api`: 「GET /rankings 只读榜单接口」——「调价后 `per100ml` 是首报价、本期接受」被本变更证伪,改为「同源于最近一次成功解析」+ **四类**仍可能不同源的窗口(且**不都自愈**),并把核对口径钉成**按分相等**(禁浮点容差)。
- `miniapp`: 「榜单行必须按失效置灰…」——拆掉「`per100ml` 冻结于首报」这个已不成立的解释前提。**客户端代码不动**,动的是条文。
- `category-tagging`: 「现有库存必须 backfill 打标签」——其「禁止重放 `/ingest`」的括注理由(first-write-wins、不覆写)被本变更推翻,收窄为「会覆写 title/price/captured_at 并触发后台 tier2」。

## 非目标

- **不新增存量重算 admin 端点**:实测其独占覆盖集为空(69/69 偏差行可由重灌修好,4 组幽灵行零偏差、零在榜),而完成判据在一个不提供完成信号的异步写入系统上无法机械成立(推导见 `design.md` D3)。
- **不改 `dedupe_key` 构造**(仍与价格无关):把价格并入键会为每次调价堆一条 `product` 行,污染榜单计数与排序。
- **不做绑定观测的条件写**(CAS / `observation_revision` 列):价格分值不能识别一次观测、首插路径也不在这类谓词覆盖内(见 `design.md` D2);做对它需要一次 schema 迁移 + 贯穿两个写点的新不变量,对人工批量导入的目录代价不相称。
- **不修「同一 raw 因标题变化堆多条 `product` 行」的既有 quirk**:实测 4 组 8 条,全为重量轴/零价商品、`per100ml` 均为 NULL、不在榜上。明细落 runbook 作已披露残留。
- **不收紧 `RawProductSchema.price` 到两位小数**:实测生产**零条** >2 位小数元价,该风险目前无实例。
- **不动 `lowest_price` 水位**的维护规则(只订正举例)、**不动**失效置灰阈值 / 榜单入榜门**判据** / 排序 / 分页 / cohort 守卫。注意「判据不变」≠「入榜集合不变」:实测 **26 条** `price ≤ 0` 的 raw,它们一被重报就会因不可计算而退出榜单(其中至少 1 条现在还挂在榜上)。
- **不解决**「重灌周期 ≈ 置灰阈值 ⇒ 解灰后很快整体再灰」这一节奏问题。
- **不做**客户端代码改动。

## 影响

- **代码**:仅 `packages/db/src/repository.ts`(`saveParsed` 三处命中分支 + 一个模块内私有的刷新语句构造函数)。`packages/core`、`packages/api-client`、`apps/miniapp` **零改动**,`apps/api` **仅注释改动**;`Repository` 公共接口 diff 为空;路由表 diff 为空。
- **既有测试**:四处断言/用例名/注释需改写(`repository.test.ts` 的「oldest wins 保留旧 per100ml」必红;`d1-dedupe.test.ts`、`taxonomy.test.ts` 的用例名与注释会静默失真),外加新增单测。
- **文档**:`docs/backfill-runbook.md`(加检测器与循环、修正「不重放 ingest」的理由链)、`docs/miniapp-product-form.md:56-61`、`apps/api/src/tagging.ts:253` 注释。
- **API**:公共端点的**请求与响应形状均不变**(`/rankings` 的 `per100ml` 值会变正确、排序随之变动)。**新增一个失败面**:去重命中过去是纯读、现在含一条写——`/contribute` 因此可能返回 `500`(附 `rawId`),`/ingest` 后台只记日志。
- **数据/合规**:只在既有 ingest 写路径上多写一条 UPDATE,不抓取、不新增出站、不触 LLM。
- **schema**:**零迁移**——五列与 `dedupe_key` 唯一索引均已在库。`persistence` 需求里那段 `dedupe_key` 迁移文字是**既有已部署前提的全文重述**(OpenSpec MODIFIED 要求带需求全文),不是本次的施工项。
- **运维**:部署 → 取基线 → 重抽 HAR 重灌 → 驱动打标签 backfill → **暂停异步 ingest 入口** → 连跑两轮行级检测确认排空 → 检测 → 经 `/contribute` 重报 → 循环至可修集为空 → 刷 CDN → 开放入口。详见 `design.md` Migration Plan。
