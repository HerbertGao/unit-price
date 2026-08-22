## Context

已核实的地面真相(实现时以代码为准,本节只记结论):

| 事实 | 出处 |
| --- | --- |
| `/rankings` 无参时**默认 `category=soft-drink`**,不是全局榜 | `routes.ts` 查询 schema;实测 `?limit=500` 返回 75 行 |
| 服务端次级排序键是 `unit_price.id`,且被投影刻意丢弃 | `repository.ts` `.orderBy(asc(per100ml), asc(unitPrice.id))` |
| `unit_price.id` 默认 `crypto.randomUUID()`,但**契约允许 UUID 或 ULID**,写入门只有 `z.string().min(1)` | `codec.ts`;`repository.ts` `IdGate`;`persistence` 主规范 |
| 每商品至多一条 category 叶边由**应用层写时维护**,非 DB 约束;现查询用 `DISTINCT unit_price.id` 兜底 | `persistence` 主规范 |
| `seedTaxonomy` 的第二趟**无条件更新 `parent_id`**;而 `category_closure` 是 seed 期物化、插入 `onConflictDoNothing` 且**只增不删**。故一次 re-parent 后 `parentSlug` 链是**新的**、闭包是**旧 ∪ 新**——依赖闭包的旧 cohort 查询可能与客户端父链派生分叉,因此 D10 将榜单与 `/compute` 收敛到同一父链来源 | `seed.ts:283-293`(update)、`seed.ts:310-328`(closure insert) |
| D1 **拒绝显式 BEGIN/COMMIT**,其原子 API 是 `batch()`;`transaction()` 只在 sqlite 分支可用 | `repository.ts` |
| 阿里云 CDN **默认把 query string 计入缓存键** | `routes.ts` 注释所记实测 |
| 服务端 `q` 用 SQLite `LIKE`,**仅 ASCII 大小写折叠**(`%café%` 不匹配 `CAFÉ`) | 本地 SQLite 实跑 |
| `apps/` 只有 `api` 与 `miniapp` | 仓内枚举 |

## Decisions

**D1 — 改造 `/rankings`,不新增端点。** 小程序尚未正式发布、API 未向第三方开放,不存在已发布消费者的兼容窗口。新增兄弟端点要付两套投影、两个缓存对象、两份排序口径,却没有需要它保护的旧客户端。

**D2 — 行与 taxonomy 同体下发。** 客户端判定归属需要两者同时在手;两个独立 TTL 对象会各自过期到不同版本,使新叶上的行被静默丢弃。

**D3 — 归属字段是 `categorySlugs`(数组),没有叶性门。**

这条在实现时被代码推翻过一次,值得记下来。原设计要求「入榜第三门:显式判定叶性,只挂非叶的行必须排除」。读代码后不成立:`attachTag` 已在**写入侧**强制叶粒度(非叶直接抛),所以唯一能产生非叶挂载的是 **taxonomy 演化**——一个叶后来长出子节点(P3.5 对 `dairy`/`soft-drink` 正是这么干的)。那些商品还在售,把它们从榜上剔除等于在一次 taxonomy 编辑里静默丢掉在售行。

故:**没有叶性门**;字段叫 `categorySlugs`(它挂了什么),不叫 `leafSlugs`(对形状的断言);归属判据是「任一 slug 是目标节点或其后代」。数组而非单值,因为单归属由应用层维护、非 DB 约束,双叶行可达——单值只有两条出路:发两行(同榜重复入榜)或二选一(丢掉另一榜的归属)。

**D4 — 没有排序键;客户端从不排序。**

同样被代码推翻。原设计要客户端按 `(per100ml, sortKey)` 重排以复现服务端全序,于是必须处理 SQLite `BINARY`(UTF-8 字节序)与 JS `<`(UTF-16 码元序)的等价问题。

但客户端做的是**过滤 + 切片**,两者都保序:派生视图**继承**服务端的序,不需要复现它。于是跨引擎比较这个问题**不存在**,连带 `sortKey` 的值域约束、`unit_price.id` 允许 ULID 的冲突、以及「rows 必须已排序」这条对象不变量一起消失。

行仍带 `id`(承载 `unit_price.id`),但它是**身份**不是排序键:客户端拿它做列表 key(`rank` 每次换 cohort/搜索都变,用它入 key 会让整列表 remount)。

**D5 — `rank` 移出行契约。** 快照行(无 `rank`)与视图行(快照行 + `rank`)是两个类型,由 `pageOf` 在切片时赋值。

**D6 — 三条读互不依赖,可同批。** 行、叶边、taxonomy 节点没有任何一条喂给另一条,故可一次性发出(D1 走 `batch()`、sqlite 走事务)取得无撕裂的装配。`/rankings` 与 `/categories` 均使用无计数的平节点投影;原先 per-node 计数的 N+1 随 `rankableCount` 一并删除。

**D7 — 单行缺陷不得打掉整份快照。** 快照是唯一数据源,一行坏 = 榜单/分类树/搜索/比价定位同时不可用。故读路径对不合规行**排除并按 reason 计数**,不抛。实现时第一版写错过:`decodeJson` 是裸 `JSON.parse`,在 `safeParse` 之前就抛,整份快照照样倒——即「排除并计数」这句话本身不生效。测试首跑就抓到,已修(try 包住 decode)。**正常的非成员(`rankable=0`、无可比轴)在 SQL 里就被滤掉,不计入 `excluded`**——否则健康信号会在健康数据上常亮。

**D8 — 搜索口径由本地单方定义。** 服务端 `q` 移除后无第二实现,不存在对齐问题。口径:`trim` → 按码点截断 ≤64 → 仅 `A-Z`↔`a-z` 折叠 → 子串,**限当前 cohort 内**。选 ASCII-only 是为与移除前命中集合一致(SQLite `LIKE` 只折叠 ASCII,JS `toLowerCase()` 折叠 Unicode)。**≥2 码点门保留**并移进共享包:单个 CJK 字符命中大半个目录,那是「搜索坏了」不是「搜索宽」。

**D9 — 全量是传输单位,cohort 是展示单位。** 任何呈现给用户的榜限定在单一可比口径内。落地 cohort **不由服务端下发**——客户端本来就握着整棵树,让服务端多发一个字段只会多一处要保持同步的地方。

但**也不由客户端从树上推导**。原设计写的是「最浅的单一可比轴节点」,读起来像可推导、实则无唯一解:`soft-drink` 与 `dairy` 同为 `beverage` 直子且同为 `per_100ml`,任何平局判据都是树不承载的额外规则。实测按字母序落到了**乳品**,而榜标题写着软饮。故落地 cohort 是**消费端的具名常量**(miniapp 的 `LANDING_COHORT`,见 `miniapp` spec),它必须与那一侧的榜标题文案同源——标题本来就是常量,只推导 slug 才是两者能对不上的原因。

**D10 — `/compute` 与榜共用同一总体。** 定位改为读同一份快照、用同一个 `cohortSlugs` 切出 cohort。原先是两条路:这边节点作用域 SQL(走物化 `category_closure`)、那边快照(走 `parentSlug` 链),两条祖先来源只在「每次 re-parent 都重建闭包」时才一致,而没有任何机制保证这件事——症状会是一个**静默错的名次**,不是报错。顺带去掉了 `COMPUTE_COHORT_FETCH_MAX` 这个上限(其注释自陈越过它「would silently under-count」)。

**D11 — 所有服务端品类节点响应均移除 `rankableCount`。** 当前客户端已持有整份快照,可从与榜相同的行集合准确派生节点数量;仓内没有只消费 `/categories` 计数的调用方。保留参考值会允许「徽标 75、榜内 74」的误导,保证严格一致则要为一个无消费者字段引入闭包原子重建、统一准入和生产前检。故 `/rankings.categoryNodes` 与 `/categories.nodes` 都只保留 `rankable` 作为可进入榜单的闸口,不再下发服务端节点计数。

## 快照字段表(单一事实源)

每个字段要么在下列**全部**站点出现,要么一处都不出现。

| 字段 | rankings-api | api-client schema | 本地派生用途 |
| --- | --- | --- | --- |
| `rows[]` | ✓ | ✓ | 全部视图的数据源 |
| `rows[].id: string` | ✓ | ✓ | 稳定行身份(列表 key);**非**排序键 |
| `rows[].categorySlugs: string[]` | ✓ | ✓ | cohort 归属(任一 slug 是目标节点或其后代) |
| `rows[]` 其余字段(`title`/`priceCents`/`per100ml`/`formula`/`confidence`/`warnings`/`store`/`storeSku`/`sourceUrl`/`capturedAt`/`lowestPriceCents`) | ✓ | ✓ | 渲染 |
| `categoryNodes[]`(`slug`/`name`/`parentSlug`/`comparableUnit`/`rankable`) | ✓ | ✓ | 祖先推导 + cohort 准入 |
| `excluded[]`(`reason`/`count`) | ✓ | ✓ | 数据健康观测 |

**不在表内、且刻意不做的**:

- `rank` —— 视图内位次,由 `pageOf` 切片时赋值。
- 排序键 —— 见 D4,客户端不排序。
- `rankableCount` —— 客户端握着全部行、自己按节点数;服务端再发一个数只会多一个可能与列表不符的数字。`GET /categories` 同样不再下发该字段。
- `defaultCohortSlug` —— 见 D9,由消费端以具名常量承载,服务端不下发、客户端也不从树上推导。
- `generatedAt` / `rowCount` —— 前者本轮未实现(要用时连同「陈旧上界」一起定,否则是个没人消费的字段);后者等价于 `rows.length`,不提供任何新信息。

## 失效阈值

成立前提是整表能一次下发。行数增长到影响首屏时本设计失效,届时需**重新引入服务端分页**——那是一次新变更,不是开关:本变更删除了客户端的分页取数与逐 cohort 请求。本期不实现自动降级。端上存储另有一道更硬的悬崖:`Taro.setStorage` 单键约 1MB。

## 实现裁决记录(六条已由代码结清)

评审阶段留下六条互斥项,交由实现裁决。结果:

| # | 争点 | 结清方式 |
| --- | --- | --- |
| Q1 | `rankableCount` 的谓词与谁同源 | **能力移除**:两个节点响应都不再下发该字段;需要数量的客户端从快照派生(D11) |
| Q2 | 「一次一致性读」在两 driver 上怎么落地 | 去掉 `rankableCount` 后三条读都是平查询、互不依赖,`batch()` 直接能吃(D6) |
| Q3 | `generatedAt` 与「带参/无参逐字相同」互斥 | **不实现 `generatedAt`**;响应对任何 query 逐字相同,由 `it.each` 六种参数形态钉住 |
| Q4 | 端上排序不变量是不是全局 kill switch | **前提消失**:客户端不排序(D4),没有排序不变量 |
| Q5 | `rankableCount` == 派生行数 与「排除并计数」互斥 | 同 Q1;不再维护第二个计数来源 |
| Q6 | 装配一致性测试断言什么 | 断言行与 taxonomy 自洽;e2e 里另有一条直接比对物化闭包与 `parentSlug` 链 |

关于服务端节点计数的两项争点不是「修好了」,而是删除了没有消费者且无法诚实承诺的能力;排序与生成时刻的争点则由前提消失而结清。

## Migration Plan

1. 合并并部署源站,此时小程序尚未发布、没有旧客户端兼容窗口。
2. 立即 purge 历史 `/rankings*` 对象,再启用 query-string 归一化。
3. 预热 `/rankings` 与 `/categories`,从国内视角确认前者为快照对象、后者节点不含 `rankableCount`。
4. 只有验形通过后才提交首版小程序。
5. 若提交前发现问题,回滚源站后再次 purge + 预热;首版小程序发布后不得单独把服务端回滚为旧数组形状,只能前向修复或协调回滚客户端。

## 已知残留

`## 修改需求` 块的场景标题不能改名(改名 = archive 硬中止),故若干场景标题保留历史措辞而正文语义已变(如「无参默认 ≡ category=soft-drink」的正文现描述全量快照)。这是 OpenSpec 机制的硬约束,编辑无法消除。
