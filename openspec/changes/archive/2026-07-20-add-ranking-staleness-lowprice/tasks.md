## 1. miniapp:失效阈值常量

- [x] 1.1 在 `apps/miniapp` 定义**小程序侧具名常量** `STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000`(裸数字、一行注释「>此值未重报 = 失效」);**禁止**从 `@unit-price/core` import(小程序对 core 无依赖边、经 babel 引 Zod 会重入 class-transform 捆绑坑)、**禁止**散写魔法数字

## 2. db:schema + 迁移(lowest_price)

- [x] 2.1 `packages/db/src/schema.ts` 给 `productRaw` 加**可空** `INTEGER` 列 `lowestPrice: integer('lowest_price')`,注释:整数分、历次**正价**观测最低价水位、可空+回填、`product_raw` 首个跨观测运行聚合列
- [x] 2.2 `pnpm --filter @unit-price/db exec drizzle-kit generate` 生成加列迁移;**核对**产出为 `0007_*.sql`(journal 最高 idx=6、磁盘最高 0006);若编号错位则改名至 `0007` 并补 `_journal.json` idx=7(规避 drizzle 撞号 trap)
- [x] 2.3 手工在该 `0007_*.sql` 尾追加幂等回填(前置一行 `--> statement-breakpoint` 与 ADD COLUMN 分隔为独立语句):`UPDATE product_raw SET lowest_price = price WHERE price > 0 AND lowest_price IS NULL;`(仅正价存量、以当前价初始化;`IS NULL` 自幂等、防误重放毁真实低点)
- [x] 2.4 本地对干净 SQLite 应用全部迁移,确认加列 + 回填成功(含一条 ≤0 价存量保持 `NULL`)、既有测试基座仍绿

## 3. db:upsertRaw 维护水位 + 榜单投影

- [x] 3.1 `repository.ts` `upsertRaw`:插入 `values` 写 `lowestPrice: row.price > 0 ? row.price : null`;`onConflictDoUpdate.set` 加 `lowestPrice: sql\`CASE WHEN ${row.price} > 0 THEN min(coalesce(${productRaw.lowestPrice}, ${row.price}), ${row.price}) ELSE ${productRaw.lowestPrice} END\``(仅正价折进、异常价保留旧水位)。**加一行注释**:`${productRaw.lowestPrice}` 在 `DO UPDATE SET` 里取**更新前**累积水位、`${row.price}` 是新值绑定参数——勿把 `${productRaw.lowestPrice}` 改写成 `excluded.lowest_price`(会取本次 INSERT 的待插值而非累积水位、破坏水位);`title`/`price`/`capturedAt` 覆写不变
- [x] 3.2 两字段须贯穿投影全链:`RawRankingRow`(`repository.ts` 预解码接口)+ `RankingRow` 加 `capturedAt: number` 与 `lowestPriceCents: number`;`buildRankingsQuery` 投影 select `product_raw.captured_at` 与 `COALESCE(product_raw.lowest_price, product_raw.price)`;`listRankings` 的 `.map()` 透传该二列(勿只改 `RankingRow` 类型漏了 map)
- [x] 3.3 db 测试:首插正价 lowest=price、首插 ≤0 价 lowest=NULL;价格回落刷新更低;价格上涨保留旧低(min 单调);**异常 0/负价重报不折进水位、保留旧低**;榜单投影含 capturedAt 与 COALESCE 后的 lowestPriceCents

## 4. api-client:RankingsItem 契约

- [x] 4.1 `packages/api-client/src/rankings.ts` `RankingsItemSchema` 加 `capturedAt: z.number().int().optional()` 与 `lowestPriceCents: z.number().int().optional()`(**可选**,容忍跨版本/CDN 旧缓存缺字段);更新文件顶部字段说明注释(注明服务端在线恒发、可选仅为兼容)
- [x] 4.2 api-client 测试:**缺** `capturedAt`/`lowestPriceCents` 的对象 `parse` **通过**(可选);**含**但值非整数(字符串/小数)`parse` **失败**;`ComputeResultSchema` 复用同 schema 故 compute 邻居行一致

## 5. apps/api:透传两字段

- [x] 5.1 `routes.ts` `/rankings` handler 投影 item 加 `capturedAt: row.capturedAt` 与 `lowestPriceCents: row.lowestPriceCents`
- [x] 5.2 `routes.ts` `projectNeighbor(RankingRow)` 同样加该二字段(`/compute` 的 `ComputeResultSchema` 按引用复用 `RankingsItemSchema`,缺则 compute 邻居行少字段但因可选不报错;仍须填充以让 compute 也能显示)
- [x] 5.3 `routes.test.ts` rankings/compute 用例断言**在线响应**每项含 `capturedAt`(epoch ms)与 `lowestPriceCents`(= `COALESCE`,现价高于低点时二者不等)——验「在线恒发」而非仅可选

## 6. miniapp:逐行标注

- [x] 6.1 `apps/miniapp` `RankingRow` 组件:`now - capturedAt > STALE_AFTER_MS`(引本地常量,任务 1.1)时整行置灰(失效仍留榜);`capturedAt` 为 `undefined`(旧缓存)时**不置灰**(`now - undefined` 非失效)
- [x] 6.2 `RankingRow`:仅当 `priceCents > lowestPriceCents` 时呈现「历史低 ¥X.XX」标注(`lowestPriceCents/100` 两位小数);否则(含 `lowestPriceCents` 为 `undefined`)不呈现
- [x] 6.3 灰态与历史低价标注样式走 `app.css` 设计 tokens(`var(--…)`),不散写颜色字面量;两标注正交可并存

## 7. 收口验证

- [x] 7.1 `pnpm -r build` + `pnpm -r test` 全绿。因二字段设 `.optional()`,既有 `RankingsItem` fixture(缺字段)仍解析通过、不批量破;但**投影/接口测试**须新增带二字段的 fixture,并核对断言精确对象形状的用例(`compute.test.ts` `validNeighbor`、`client.test.ts` `validItem`、`useRankings.test.ts`、`boardCache.test.ts`)
- [ ] 7.2 小程序 devtools 实测:构造一条 >30 天未更新且现价高于历史低点的样本,确认置灰 + 「历史低」标注同时正确呈现;30 天内且现价=历史低点的行无标注;异常价样本不显示历史低。**并在即时比价页**核对:一条失效/高现价的**邻居行**同样置灰 + 标历史低,而**用户自填行**(无二字段)不置灰不标注
- [x] 7.3 构造**缺二字段的旧响应**(模拟 CDN 旧缓存/旧服务端),确认 `parseRankingsResponse` **解析通过**、该行降级为无灰无徽标,**不崩溃、不整屏错**(可选字段容错,非 fail-closed 重取)
