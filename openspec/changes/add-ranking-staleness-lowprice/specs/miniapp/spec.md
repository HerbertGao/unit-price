## 新增需求

### 需求:榜单行必须按失效置灰并在现价高于历史低价时标注历史低价

榜单行组件(`RankingRow`)**必须**消费 `/rankings` 响应的 `capturedAt` 与 `lowestPriceCents`,做两项**逐行**读侧标注(纯前端派生,不改榜单请求/排序/分页):

- **失效置灰**:当 `now - capturedAt > STALE_AFTER_MS` 时,该行**必须**呈现为「失效/灰态」视觉(整行降饱和/置灰),以示该单价久未更新;但该行**仍在榜内**(失效**不下架**,它正是「历史上便宜」的参考项)。置灰**仅为视觉**、以客户端当前时间判定;**禁止**依赖服务端返回的失效布尔。阈值 `STALE_AFTER_MS = 30*24*60*60*1000` 由**小程序侧具名常量**提供(前端**禁止**另写魔法数字):**不从 `@unit-price/core` import**——小程序对 core 无依赖边(仅依赖 `@unit-price/api-client`、经 esbuild vendor 别名绕开 babel 对 Zod 的 class-transform),新开 miniapp→core 边既是幽灵依赖、又重入该 Zod 捆绑坑;`STALE_AFTER_MS` 是裸数字、定义在小程序侧最简且零捆绑风险。
- **历史低价标注**:仅当 `priceCents > lowestPriceCents`(现价高于历史低点)时,该行**必须**呈现「历史低 ¥X.XX」标注(`lowestPriceCents/100` 两位小数);`priceCents <= lowestPriceCents`(现价即历史低点)时**禁止**呈现该标注(无「错过抄底」信号,免噪)。
- **缺字段降级(跨版本 / 旧缓存)**:`capturedAt`/`lowestPriceCents` 契约为 `.optional()`,故旧服务端或 CDN 24h 旧缓存响应可能缺其一。缺 `capturedAt` 时**禁止**置灰(`now - undefined` 判定为非失效),缺 `lowestPriceCents` 时**禁止**呈现历史低价标注——即退化为无标注的既有行为,**禁止**崩溃或整屏错。
- 置灰与历史低价标注**相互正交**:一行可同时失效且现价高于历史低点,两标注可并存。
- **三价并存是可接受的呈现结果**:一行可同时展示 `per100ml`(冻结于首报的排序大字)、`priceCents`(最新整件价)、`lowestPriceCents`(历史低)三个口径不同的价。徽标只对比 `priceCents` vs `lowestPriceCents`(同为整件分)、**不与 `per100ml` 混算**;UI 是否把「历史低」徽标与排序大字在视觉上分离由本需求交实现斟酌,但须知这是既有 per100ml 冻结 quirk 的自然延伸、非计算错误。
- **标注随 `RankingRow` 组件生效于其所有渲染面**:`RankingRow` 除榜单列表外,还被即时比价页复用渲染 `neighbors`(邻居行)。邻居行是真实榜单行、带真实 `capturedAt`/`lowestPriceCents`(经 `projectNeighbor` 填充),故**同样**按上述规则置灰 / 标历史低——这是正确且期望的。但用户**自填的比价行**(非 `RankingsItem`、无 `capturedAt`/`lowestPriceCents`)**禁止**置灰或标注(走缺字段降级路径)。
- 本需求约束逐行标注的呈现逻辑,**不**引入榜单顶部「全局新鲜度横幅 / 更新于 X月X日」——该全局横幅仍属 P8、非本期(与逐行置灰不同)。呈现所用颜色**必须**沿用 `app.css` 设计 tokens、**禁止**在页面/组件散写颜色字面量(遵既有「设计 tokens 集中」约束)。

#### 场景:>30 天未重报的行置灰但仍在榜
- **当** 榜单某行 `capturedAt` 距当前已超过 `STALE_AFTER_MS`(30 天)
- **那么** 该行**必须**呈现失效/灰态视觉,且**仍出现在榜单列表内**(未被移除、rank 序不因失效改变)

#### 场景:30 天内的行正常呈现
- **当** 榜单某行 `capturedAt` 距当前在 30 天以内
- **那么** 该行**必须**以正常(非灰)态呈现

#### 场景:现价高于历史低点时标注历史低价
- **当** 榜单某行 `priceCents = 1490`、`lowestPriceCents = 990`
- **那么** 该行**必须**呈现「历史低 ¥9.90」标注

#### 场景:现价即历史低点时不标注
- **当** 榜单某行 `priceCents = 990`、`lowestPriceCents = 990`(现价即历史低点)
- **那么** 该行**禁止**呈现历史低价标注

#### 场景:失效与历史低价标注可并存
- **当** 某行既 `capturedAt` 超 30 天、又 `priceCents > lowestPriceCents`
- **那么** 该行**必须**同时呈现灰态与「历史低 ¥X.XX」标注(两标注正交、不互斥)

#### 场景:缺字段的旧响应降级为无标注而非报错
- **当** 榜单某行(来自旧服务端 / CDN 旧缓存)`capturedAt` 或 `lowestPriceCents` 为 `undefined`
- **那么** 该行**禁止**置灰(缺 `capturedAt`)、**禁止**呈现历史低价标注(缺 `lowestPriceCents`),退化为无标注的正常行,**禁止**崩溃或触发整屏错

#### 场景:即时比价页的邻居行同样标注、用户自填行不标注
- **当** 即时比价页经 `RankingRow` 渲染 `neighbors`(一条失效且现价高于历史低点的邻居)与用户自填比价行
- **那么** 邻居行**必须**按规则置灰 + 标「历史低」(它是真实榜单行);用户自填行(无 `capturedAt`/`lowestPriceCents`)**禁止**置灰或标注
