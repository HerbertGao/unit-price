## Context

榜单读侧现状(已核对代码):

- `product_raw` 按 `(store, store_sku)` upsert,`price`/`captured_at` 每次重报覆写为最新(`repository.ts` `upsertRaw`),provenance 列走 COALESCE。→ 「最后一次报价时间」与「现价」都是真实、随重报刷新的事实。
- `unit_price.per100ml` 是 first-write-wins,冻结在首报(`saveParsed` dedupe_key 去重)。榜单按冻结 per100ml 排序、行内显示最新整件价 `priceCents`——既有 quirk,rankings-api 现规范已声明「本期接受」。
- 榜单响应 `RankingsItem`(SOT 在 `packages/api-client/src/rankings.ts`)已含 `priceCents`,但无 `captured_at`。`RankingsItem` 只从库内 `RankingRow` 投影:`/rankings` 直接投影、`/compute` 的 `neighbors` 经 `projectNeighbor(RankingRow)` 投影,用户自填行不是 `RankingsItem`。
- 迁移:`packages/db/drizzle/` 磁盘最高前缀 `0006`,journal(`meta/_journal.json`)最高 idx=6(0004/0005 是未登记 journal 的目录扫描 DML 种子)。

约束:纯读侧标注,不碰抓取/众包合规面;生产 push-to-main 自动 migrate,加列须对非空表安全;`/rankings` 经 CDN + 端上 SWR 缓存。

## Goals / Non-Goals

**Goals:**

- 榜单行透出足够信号,让前端把「>30 天未重报」的行置灰(仍留榜)。
- 给商品透出「历史最低价」,前端在现价高于历史低点时提示。
- 复用既有数据,零新增基础设施(无 cron、无历史价格表)。

**Non-Goals:**

- 不修 `per100ml` 冻结在首报的既有 quirk。
- 不追溯存量历史价格(`lowest_price` 存量初始化为当前价)。
- 不加服务端定时任务或物化「失效」标记列。
- 不做榜单顶部全局新鲜度横幅(逐行置灰 ≠ 全局横幅,后者仍 P8)。
- 不改 ingest 契约去校验 `capturedAt` 合理性(量级/未来偏移/单调)——属既有 ingest-input 收紧、跨越本变更范围,记为后续跟进;本期靠「省略则服务端 `Date.now()` ms」与运营侧约定兜底(见 Risks)。

## Decisions

**D1:失效判定放客户端,响应只透出 `capturedAt`(不返回服务端 `stale` 布尔)。**
理由:`/rankings` 经 CDN/SWR 缓存,任何时间相对的布尔(`now - captured_at > 30d`)烤进响应体后会随缓存龄期衰减——缓存写入时 `stale=false`,几小时后读到仍是 `false` 却已过期。`captured_at` 是不可变事实,缓存安全;置灰是纯视觉,客户端时钟足够。阈值 `STALE_AFTER_MS = 30*24*60*60*1000` 作**小程序侧命名常量**(展示策略、服务端不消费):**不入 `packages/core`**——core 是 parse/calc 领域包,且小程序对 core **无依赖边**(`package.json` 只依赖 `@unit-price/api-client`,后者经 esbuild vendor 产物别名进 weapp 以绕开 babel-preset-taro 对 Zod 的 class-transform),新开 miniapp→core 直接 import 既是幽灵依赖、又重入该 Zod 捆绑坑;`STALE_AFTER_MS` 是裸数字常量、直接定义在小程序侧最简且零捆绑风险,满足「前端禁魔法数字」(具名常量单一源)。前端 `now - capturedAt > STALE_AFTER_MS`;日后若 web/插件也渲染榜单再提升为共享常量(YAGNI)。
备选:服务端返回 `stale` 布尔——被缓存衰减否决;放 `packages/core`——被 weapp 捆绑坑否决(见上)。

**D2:历史最低价用 `product_raw` 新增列 `lowest_price` + upsert 维护水位,不建价格历史表。**
理由:需求只要「历史最低」这一个标量,不要完整流水。一个水位列 + 每次 upsert `min(既有水位, 新价)` 即可,O(1) 存储、无表 join。
备选:`price_history` 明细表——为一个 min 标量建表属过度设计(YAGNI)。

**D3:`lowest_price` 列可空 + 仅正价入水位 + 幂等回填 + 读投影 `COALESCE`。**
`lowest_price` 加为**可空 `INTEGER`**(对非空 prod 表安全、无需 DEFAULT;可空列加列的安全性同 `native_category_id` 加列先例)。**水位只纳入正价观测**(`price > 0`)——`product_raw` 忠实存**含异常价**(`RawProductSchema` 放行 ≤0/负价,由 core 路由到 per100ml=null),若把 0/负价折进 `min` 会永久毒化水位(`min` 单调只降),叠加 `unit_price` first-write-wins 使已入榜项恢复价后显示「历史低 ¥0.00」或负值。故:
- `upsertRaw` 首插写 `lowest_price = (price > 0 ? price : NULL)`;冲突写 `CASE WHEN 新价 > 0 THEN min(coalesce(lowest_price, 新价), 新价) ELSE lowest_price END`(新价为正才折进、否则保留旧水位;`coalesce` 兜住无水位时以新价起算)。
- 迁移尾部一次性回填 `UPDATE product_raw SET lowest_price = price WHERE price > 0 AND lowest_price IS NULL`(只回填正价存量;`WHERE ... IS NULL` 使回填**自幂等**——即便 journal 被手工改动误重放也是 no-op、不把已累积真实低点重置回当前价;`price > 0` 排除异常价存量)。
- 读投影 `COALESCE(lowest_price, price)`,故服务端**投出**的 `lowestPriceCents` 恒为整数;仅当 `priceCents > lowestPriceCents` 时前端才呈现「历史低」,故 NULL 水位退化为当前价时(相等)不呈现、异常价也不会被当作历史低呈现。
备选:`NOT NULL DEFAULT 0`——`0` 是错误哨兵(回填前会显示历史低 ¥0.00),否决;无正价守卫的裸 `min`——被 M-A 异常价毒化否决。

**D4:`product_raw` 历史最低价水位作 `persistence` 的一条新增需求(非修改基础 product_raw 需求)。**
理由:跟随仓库把 `native_category_id` 以**独立需求**加入的先例(而非改「product_raw 必须落地每次上报」),降低对长需求的重述漂移。注:此为独立-需求的**结构**先例;语义上 `lowest_price` 是 `product_raw` 首个**跨观测运行聚合**列(既有列——含 `native_category_id`——都是当次/首次观测的时点属性、冲突走 COALESCE),故 docstring 需点明这一新语义。该列仍是正确落点(为一个标量建 `price_history` 表属过度设计——见 D2;`unit_price` per-product 且 first-write-wins 冻结、无法派生 per-raw 水位)。

**D5:`RankingsItem` 两新增字段 `capturedAt`/`lowestPriceCents` 用 `.optional()`(非必填)。**
`RankingsItemSchema` 由**独立发布节奏不同**的 `apps/api`(push-to-main 自动部署)与 `apps/miniapp`(微信独立多日审核)**共依赖同一份**。若设必填:①旧服务端 + 新小程序(跨版本)、或②**CDN 24h TTL 缓存的旧响应**(缺字段、部署后最长 24h 仍被边缘投喂,`/rankings` 带 `public, max-age=86400`)会让新小程序 `parseRankingsResponse` 抛 ZodError → 整屏榜单错误(D1「D5 之前的必填」原设理由「每项都从真实 RankingRow 投影、无缺字段合法态」只对**单一 deployable 的服务端投影**成立,对**跨 bundle/跨缓存**的客户端暴露不成立)。设 `.optional()`:Zod 默认 strip-unknown 使旧客户端本就容忍新字段,`.optional()` 再使新客户端容忍旧服务端/旧缓存;客户端**免费降级**——`now - undefined > STALE` = `false`(不置灰)、`priceCents > undefined` = `false`(不标注)。服务端投影**仍恒发**二字段(D3),故稳态(同版本)功能完整;`.optional()` 只在跨版本/旧缓存时容错、并顺带消除旧端上 SWR 缓存的 ZodError→重取闪烁。契约单一事实源在 `api-client`,`rankings-api` 与 `api-client` 两份 spec 的字段枚举同步更新;`/compute` 的 `ComputeResultSchema`(`compute.ts` `neighbors: z.array(RankingsItemSchema)`)**按引用复用**同一 schema,故两字段自动传播到 `/compute` 邻居行(`projectNeighbor` 负责填充)、无需改 compute 契约。
备选:必填 + 部署编排(先服务端后小程序)+ CDN purge/版本化缓存键——为一个装饰性徽标引入部署顺序耦合与缓存基建,过度工程,否决。

**D6:迁移编号 `0007`,DDL 走 `drizzle-kit generate`、回填 `UPDATE` 手工追加进同一 `.sql`。**
journal 最高 idx=6 → generate 产出 idx=7 / `0007_*.sql`(与磁盘最高 `0006` 不撞)。生成后手工把回填 `UPDATE` 追加到该文件尾(单迁移原子应用,journal 保证不重放)。落地时**核对**生成文件确为 `0007`;若 drizzle 因 journal/磁盘错位编到更低号,改名至 `0007` 并补 journal idx=7(规避既知 drizzle 撞号 trap)。

## Risks / Trade-offs

- [`lowest_price` 是**尽力而为**水位,历史低不可完全追溯] → 接受并显式声明:①存量无流水,只能初始化为当前价;②**迁移先于部署**(deploy.yml 先 migrate 后 deploy),窗口内旧 worker 更新 `price` 却不写新列,若一个新低恰落在该短窗口(秒级)可能未被捕获——与①同属尽力而为限制,且**下次以≤该低点再报即自愈**(`min` 折进)。不为装饰性徽标引入两阶段/触发器 rollout。
- [客户端时钟偏差可能让边界行(≈30 天)在不同设备置灰不一致] → 置灰是纯视觉、低风险;不影响排序/入榜/任何计算。
- [30 天阈值 vs 实际 ingest 节奏——**上线首日大面积置灰**风险] → prod 由**低频手工 /ingest 批次**供数、品类价可数月不变,故相当比例存量行 `captured_at` 可能已 >30 天,该特性把 `captured_at` 从被动 provenance 抬为可见信号后,**首日可能整屏泛灰**(近乎全灰 ≡ 无区分度)。30 天是**用户指定值**、不擅改;落地前**应一次性查 prod**(`captured_at` 早于 30/60/90 天的行占比)校准这把**调参旋钮**,或**显式接受**「首屏偏灰、随再 ingest 自愈」为预期。此为需暴露的假设、非 bug。
- [`per100ml` 冻结 quirk 使排序基准(首报单价)与 `priceCents`/`lowest_price`(最新/历史)口径不同] → 本次不修,沿用 rankings-api 现规范「本期接受」;前端历史低价徽标只对比 `priceCents` vs `lowestPriceCents`,不与 `per100ml` 混算。
- [加列迁移对非空 prod 表] → 可空 `INTEGER` 加列 SQLite 安全,回填 `UPDATE` 幂等(`WHERE ... IS NULL` + journal 双守),与既有 `native_category_id` 加列同已验证路径。
- [`RankingsItem` 加字段 vs 独立发布/CDN 缓存] → 二字段设 `.optional()`(D5),使跨版本(旧服务端/新小程序)与 CDN 24h TTL 旧缓存响应均能解析、免整屏错误与端上 SWR 重取闪烁;无需 CDN purge/版本化缓存键。
- [`capturedAt` 被抬升为新鲜度信号,但时间戳无强不变量] → `capturedAt` 是观测时刻,存为 epoch **ms**(schema 注释 "Epoch (ms)"、`toEpochMillis`);**省略时服务端置 `Date.now()`(ms)可信**。残余风险:`/contribute`·`/ingest` 允许**运营方**(API key 受保护端点、非公开对抗输入)显式传 `capturedAt`,仅 `.int()` 校验、不校验量级/单调——传成**秒**会全表恒失效、传**远未来**会恒新鲜、乱序补报会回退时间戳。影响限于**装饰性置灰**(错灰,无价格/排序/数据损坏),且运营方误配是自诊断的(整屏灰=显然)。**建议 ingest 省略 `capturedAt`、由服务端盖章**。在 ingest 侧加 `capturedAt` 量级/未来偏移合理性校验会**改动既有 ingest 契约**(收紧此前放行的输入)→ 属本变更范围外,记为后续跟进(见非目标)。

## Migration Plan

1. `packages/db/src/schema.ts` 加 `lowestPrice` 可空 `INTEGER` 列。
2. `pnpm --filter @unit-price/db drizzle-kit generate` → 得 `0007_*.sql`(ADD COLUMN);核对编号,必要时改名 + 补 journal。
3. 手工在 `0007_*.sql` 尾追加 `UPDATE product_raw SET lowest_price = price WHERE price > 0 AND lowest_price IS NULL;`(仅正价、幂等)。
4. 生产 push-to-main 自动 migrate 应用 0007(加列 + 回填一次);deploy.yml 先 migrate 后 deploy,窗口内的水位遗漏按尽力而为接受(见 Risks)。
5. 回滚:该迁移只加一列 + 回填,读侧 `COALESCE` 与前端条件渲染、且响应字段 `.optional()`,对缺列/旧客户端/旧缓存均向后兼容;必要时前端可临时不渲染两字段而不影响榜单主体。
