## Context

问题与生产实测数见 `proposal.md`「为什么」(不在此复述,避免两处各记一份而漂移)。本文只记落地所需的技术约束与决策。

代码侧现状:`saveParsed` 的两条命中分支(sqlite `onConflictDoNothing` + `changes=0`;D1 SELECT-first)与一条回退分支(D1 抢插失败 → catch 内重查)**都只读不写**,故 `product_raw.price` 前进而 `unit_price` 冻结。

约束(逐条已核对代码):
- better-sqlite3 的 `transaction` 回调**必须同步**;回调体内一旦出现 `await`,其后的语句会在 COMMIT **之后**才执行且**不报错**(见 D4 的实测口径)。drizzle 的 builder 是惰性的,忘记执行同样一声不响。
- `/ingest` 是 `202` + 后台解析(`waitUntil`),`/ingest/batch` 还有 `BG_POOL=5` 并发池:同一 SKU 两次上报的 `upsertRaw` 顺序与其 `saveParsed` 完成顺序**可逆**。后台失败**只记日志、不重试**。
- `product_raw.price` 的**唯一写者**是 `upsertRaw`。三条调用路径都在**同一次请求**内随后调 `saveParsed`,但只有 `/contribute` 是同调用内紧邻;`/ingest` 与 `/ingest/batch` 的 `saveParsed` 在 `waitUntil` 后台单元里执行,且 batch 会**先把整批的 `upsertRaw` 跑完**再由 `BG_POOL=5` 并发 drain —— 「随后」**不蕴含「有序」**。
- `unit_price.warnings` 存的是 `orchestrate` 汇总的**并集**(tier1 + tier3 + LLM 复核状态);`confidence` 则是 `calculate` 的直出值、由编排原样透传。
- `/rankings` 的无 `q` 响应带 `public, max-age=86400`,数据变更后按 runbook 刷 CDN。

## Goals / Non-Goals

**Goals:**
- 重报新价后,`unit_price` 的派生值与留痕在**同一次 ingest 内**跟上;三条命中分支行为一致。
- 给运维一个**逐行可判定**的偏差检测手段,和一个能收敛的修正循环。
- `product` 的「保留最老一条」与 `saveParsed` 的 id 幂等、签名**均不变**;公共 API 形状不变。

**Non-Goals:** 见 `proposal.md`「非目标」(不新增重算端点、不改 `dedupe_key`、不做条件写 / 观测版本列、不修幽灵行、不收紧 price 小数位、不动置灰阈值与榜单口径、不动客户端)。

## Decisions

### D1:去重命中时刷新 `unit_price`(而非把价格并入去重键)

- **备选 A:把价格并入 `dedupe_key`** —— 每次调价新增一条 `product` + `unit_price`。否决:违反「相同结果只保留最老一条」,榜单会按同一 SKU 的多条历史行重复计数/排序;且 `product_raw` 只保留最新价,历史行会永久指向一个已不存在的价。
- **备选 B:保持 first-write-wins,靠周期性重算补偿** —— 否决:每次 ingest 都新增一批偏差,偏差窗口内榜单排序是错的。**闸开在写入侧**。
- 代价:`unit_price` 不再是「首报快照」。可接受——它本就是派生表,`formula` 同步更新后仍可回放;`lowest_price` 水位承担「历史最低」语义。

### D2:刷新是**无条件写**,不做条件谓词

曾设计成绑定观测价的条件写(CAS),**整条撤除**,因为它既不成立也不收敛:

- **价格值不能识别一次观测**:`yuanToCents` 是 `Math.round`,相差不足一分的两个元价折算成同一个分值;`A→B→A` 的价格回摆是促销常态,构成 ABA。
- **首插路径根本不在谓词覆盖内**:A 报 ¥10 解析慢、B 报 ¥20 推进了 raw 但**解析失败**(后台不重试),随后 A 完成解析时该 `dedupe_key` 尚不存在 → 走**插入**分支,落下按 ¥10 算的派生行。刷新侧的谓词一个字都管不到它。
- **跳过不收敛**:一旦「跳过」就假定「有更新的写者会写对」,而后台解析失败时那个写者根本不存在——跳过的行就此无人收拾。

无条件写至少让**最后完成的解析结果**落地。它的代价是诚实的:派生值可能落后于 `product_raw.price`,成因恰为 `contribute-ingest`「观测优先的两段落地」列举的**四类**(解析未完成或失败 / 刷新写失败 / 落地顺序与解析完成顺序可逆 / 解析结果漂移)。前三类的收敛动作是**再重报一次该商品**;**第四类没有收敛动作**——旧 `product` 行的 `dedupe_key` 永不再被命中,再重报只会写新行,它属**已披露残留**、只在普查中登记。**禁止**把任何一类写成「自动实时收敛」。

### D3:存量修正靠重灌 + 逐行检测器,不新建重算端点

关闸之后,存量偏差行的修法是运维**本来就要做**的那件事(重抽 HAR 重灌以解置灰)。实测数支持这个取舍:

| 行的类别 | 重灌能修? | 专门的重算端点能修? | 实测量 |
|---|---|---|---|
| raw 价推进了、派生值没跟上 | **能**(关闸后自动) | 能,但纯冗余 | **69 / 69** |
| 新 HAR 里没有的 SKU(下架/未抓到) | 不能 | **也不能**(raw 价没动 → 重算结果等于既有值) | — |
| 幽灵行(标题变过 → `dedupe_key` 永不再命中) | 不能 | 能,但会把它变成「更可信的错值」并销毁其唯一检测信号 | 4 组 8 条,**零偏差、零在榜** |

也就是说,重算端点唯一独占的覆盖集,正是本变更认定不该动的那一类,而且当前为空。为它引入一个公共契约、一套失败分类与完成判据不划算——尤其是**完成判据在一个不提供完成信号的异步写入系统上无法机械成立**:任何「扫一遍没差异就算完」的判据都探测不到仍在飞行的后台写(它写的是同一个价配同一个 spec,与扫描算出同一组值),也不排除扫描结束之后才落地的迟到写。

**取而代之的完成判据是一个逐行谓词**,它关于**存储状态**、与后台是否在跑无关。可跑的完整查询见 `scripts/census-drift.sql`(②),核心谓词是:

```sql
up.formula IS NOT NULL
  AND CAST(ROUND(CAST(up.formula AS REAL) * 100) AS INTEGER) <> r.price
```

(`CAST(formula AS REAL)` 取最长前导数字前缀、遇空格即停,与 `substr`/`instr` 提取首项等价而少两个函数,并消掉「formula 无空格时 `substr(x,1,-1)` 得空串 → 恒判偏差」这一类假阳。)

**覆盖面必须写死,否则判据会撒谎**:
- 该谓词只覆盖 **`formula` 非空**的行。`formula IS NULL` 的行(不可计算终态)求值为 NULL、被 `WHERE` 丢弃——它们**不在检测器覆盖内**,**不等于**「干净」。互补普查用 `WHERE up.formula IS NULL AND r.price > 0`(派生说不可算、raw 说可算)单独计数。
- 检测器从 `unit_price` 起 join,故「有 product 无 unit_price」与「有 raw 无 product」(后台首插失败的既有中间态)**整类不可见**。`census ④` 与「本轮重灌 SKU 集合 − 落到 product 的集合」差集**是并列的终止门**,不是可选参考。
- 互补普查 `formula IS NULL AND price > 0` 产出的是**人工复核清单**,不是失败门(实测 **227 行**;**行数不构成任何一侧的证据**,成分只能人工抽样看 spec):它无法区分「过期的 NULL」(曾 ≤0 价落 NULL、重报正价后解析失败)与「合法不可计算」(正价但无轴/规格不一致)——区分二者需要按已存 spec 重算,而那正是本变更删掉的能力。
- 谓词依赖 `formula` 的 canonical 形态。该列的**唯一写者**是 `saveParsed`,值恒来自 `calculate`,故畸形串(如 `22.8oops / …` 被宽松 CAST 取成 `22.8`)在当前代码下不可达;**若将来出现第二个写者,该谓词必须同步加严**。

**完成判据不是「空集」,而是「可修集为空」**:偏差行里属**幽灵 raw**(同一 `raw_id` 挂多条 `product`)的那部分,重报只会写新键、修不到旧行,**永远留在检测结果里**。`scripts/census-drift.sql`(②)已经把这两半分列算好:

- `drifted_fixable_by_reingest = 0` —— **终止条件**;
- `drifted_ghost` —— 逐轮记数,作**已披露残留**登记,**不进**终止条件。

运维循环 = 跑检测 → 对**可修**的那部分点名 SKU 重报一次 → 再跑,直到可修集为空。**逐行终止,不需要全局静默这个概念。**

**但「检测干净」只是查询瞬间的快照,不是持久完成保证** —— 除非迁移窗口内没有在飞的异步写。反例:A 先 `upsertRaw(¥10)` 后慢解析,B 后 `upsertRaw(¥20)` 且先 `saveParsed(¥20)`;此刻检测为零,随后 A 的无条件刷新落下 ¥10,留下 `raw=¥20 / unit_price=¥10` 且**无后继写者**。系统没有 drain 信号,所以「等后台落定再跑检测」不可执行。因此迁移**必须**用一个显式边界替代它。**重灌本身走 `/ingest/batch`**,故边界只能立在重灌**之后**——先灌满、再关闸,不能反过来:

1. **重灌与打标签 backfill 在入口开放时完成**,它们就是那批异步写;
2. 灌完后**暂停异步 ingest 入口**(`/ingest`、`/ingest/batch`),此后唯一写者是运维自己;
3. **排空只有经验判据、没有证明**:关闸后连跑两轮行级检测,**逐行输出相同**即视为在飞单元已落定。它只说明观察间隔内没有新写落地,**不**排除更长的延迟单元;
4. 点名重报**一律走 `/contribute`** —— 它是同步的(`upsertRaw → orchestrate → saveParsed` 全在请求内完成),不产生在飞单元,故重报写完即终态;
5. 最终检测在窗口内跑完,**之后**再开放入口。

第 3 步的经验判据不成立(或不愿等)时,完成判据**降级为**「查询瞬间干净」,并明示迁移不给持久保证。

**核对必须按分比较,禁止浮点容差**:`|首项 − price/100| ≤ 0.01` 会把真正过期一分钱的行判绿(`22.80` 对 `2281` 的浮点差 ≈0.00999…)。按分相等则接受合法舍入、拒绝过期行。SQLite 的 `ROUND` 与 JS `Math.round` 在本链路上**无分歧**(二者吃同一个 IEEE-754 乘积;分歧只在负半整数,而 `price ≤ 0` 时 `calculate` 直接给 `formula: null`,不可达)。(实测生产 >2 位小数元价为**零条**,该口径目前无实例,但检测 SQL 照此写不吃亏。)

### D4:刷新的实现边界

- **共用构造、执行分驱动**:`SET` 载荷与 where 谓词由**同一个纯函数**产出(模块内私有,不进 `Repository` 公共契约——没有跨包调用方);better-sqlite3 在同步事务回调内立即执行,D1 侧 `await`。
- **sqlite 事务回调必须是同步函数、回调体内零 `await`、刷新恰好一条语句**。实测:一条 UPDATE 若前面没有任何 `await`,即便写在 `async` 函数里也**同步落在事务内**;但只要 UPDATE 之前插入任何一次 `await`(例如加个读回校验),该语句就会逃到 COMMIT 之后执行且**不报任何错**。drizzle builder 构造后**必须**执行——忘记执行是静默 no-op。这两条都没有 runnable check(本仓 lint 是 placeholder、无 `no-floating-promises`),靠 review 守。
- **只共用构造,禁止共用执行器**:D1 driver 的 `.run()` 返回 Promise。若把执行也抽成跨驱动帮手,它在 sqlite 下同步生效、在 D1 下产出一个**未 await 的浮动 promise**;而 `/contribute` 的 `saveParsed` 不在 `waitUntil` 内,响应返回后 Worker 可能直接销毁它 —— **写丢失且无错误**。D1 两处刷新**必须 `await`**。
- 写入值就是入参 `calc`(已过 `CalcResultGate`,`warnings` 即编排并集),与首插分支逐字同源 —— 因此**不需要** warnings 集合运算、**不需要**影响行数判定、**不引入**任何新的计算路径。

## Risks / Trade-offs

- **[乱序或解析失败会让派生值短暂落后]** → 见 D2:收敛动作是再重报一次;检出手段是 D3 的检测器。**禁止**声称自动自愈。
- **[≤0 异常价重报会让该行整条退出榜单]** → `calculate` 对 `price ≤ 0` 返回不可计算,刷新把 `per100ml` 写 NULL,而榜单数据门是 `per100ml IS NOT NULL`。实测生产有 **26 条** `price ≤ 0` 的 raw(至少 1 条现在还在榜上显示着 `per100ml=2.00`)。「不动入榜门」指**判据**不变、不是**入榜集合**不变;这也是任一合法公共 `API_KEYS` 凭据都能触发的确定性效果——**它现在能改的是榜单排序键**,变更前只能改展示的整件价。验收时须核对榜单行数变化并归因。
- **[幽灵行仍然存在且不被本变更修]** → 实测 4 组 8 条,全为重量轴/零价商品、`per100ml` 均 NULL、不在榜。明细落 runbook 作已披露残留;若日后规模变大再单独立项。
- **[刷新是新增的失败面]** → 去重命中过去是纯读、现在含一条写。`/contribute` 因此可能 `500`(附 `rawId`),`/ingest` 后台只记日志。该态由下一次重报收敛。
- **[`/ingest/batch` 每项多一条 D1 写]** → 重灌是全命中场景、`MAX_BATCH=40`。D1 绑定调用计入 **subrequests to internal services**(Free 档 1000),与 `MAX_BATCH` 所限的 tier2 外部 fetch(Free 档 50)是**两个不同的预算**。`routes.ts` 的 `MAX_BATCH` 注释算的是外部 fetch,不受本变更影响;但 `apps/api/src/tagging.ts` 推导 `ADMIN_BACKFILL_MAX_LIMIT = 5` 时把 **D1 调用记进了 50 那个桶**,该前提被此事实证伪(是否上调 5 属另案,本变更只订正注释前提)。
  代价可量化而非「可忽略」:全命中项每项 D1 调用 3 → 4,`MAX_BATCH=40` ⇒ 每次 invocation **120 → 160**,占 internal 预算 16%;`unit_price` 带 `per100ml_idx`/`per100g_idx`,`set` 恒含这两列故每次刷新写 1 行 + 2 索引项。
- **[存量口径过时]** → 文档多处写着「~376/445/~400 行」,实测是 **1197 products / 1297 raws / 507 rankable**。本次顺手把真数写进 runbook。

## Migration Plan

**前提:检测与重报环节在一个「暂停异步 ingest」的窗口内完成**(见 D3)——否则「检测干净」只是查询瞬间的快照。重灌在关闸**之前**,它本身就走 `/ingest/batch`。

1. **合并部署**(push main → 自动 migrate + deploy)。**无 schema 迁移**:五列与 `dedupe_key` 唯一索引均已在库,本变更纯行为改动。
2. **取基线**(只读):记榜单行数、检测器输出、幽灵行清单,否则末步的「变化」无从归因。
3. **重抽 HAR 重灌**(经 `/ingest/batch`,入口仍开放)。命中行的派生值随该次解析落地而刷新。
4. **驱动打标签 backfill**(`POST /admin/backfill`,**从空 cursor 起跑**)。ingest 三条路径**都不打标签**,故重灌中标题漂移产生的新 `product` 行是 `rankable=0`、不入榜,而被弃的旧行仍带 tag 在榜;二者共享同一条 `product_raw`,于是榜上会出现「刷新过的 `capturedAt`(不置灰)配冻结的 `per100ml`」——正是本提案要消灭的那个态。这一步把新行拉进榜。
5. **关闸并确认排空**:暂停 `/ingest` 与 `/ingest/batch` 入口,连跑两轮 census ②b 直到逐行输出相同(D3 第 3 步的经验判据;不成立则完成判据降级为快照)。
6. **跑检测**(`scripts/census-drift.sql`):取 **②b** 输出的可修偏差行 `(store, store_sku)` 明细,与本轮 HAR 的 `(store, storeSku)` 求交,交集外的行直接进残留表(无数据源可重报);同时跑 ④ 与「本轮重灌 SKU − 落到 product」差集,二者是**并列的终止门**。
7. **对交集里的 SKU 经同步 `/contribute` 重报**(**禁止**走 `/ingest`——那会再引入在飞单元),回到第 6 步,直到 `drifted_fixable_by_reingest = 0` 且两个并列门为空;`drifted_ghost` 逐轮记数、作已披露残留登记。
8. **刷 CDN + 预热**,**再开放** ingest 入口。
9. **记录**:偏差归零前后对比、榜单行数变化及其**两个**成因(≤0 价行退出;解析漂移产生的 `rankable=0` 新行——`SELECT COUNT(*) FROM product WHERE rankable = 0 AND raw_id IN (SELECT raw_id FROM product GROUP BY raw_id HAVING COUNT(*) > 1)`)、以及**重灌后重跑**的幽灵行普查(第 4 步会改变该集合,基线清单不能复用)。

回滚:代码回滚即恢复旧行为;已刷新的 `unit_price` 行无需回滚(它们是按当时观测算出的正确值)。
