## 修改需求

### 需求:POST /compute 必须按结构化输入确定性计算单价并在所选 cohort 内定位

`apps/api` **必须**提供无状态端点 `POST /compute`,对结构化入参做确定性单价计算并在所选品类 cohort 内定位。`/rankings` 改为全量快照后,本端点的**定位总体来源**随之改变:计算管线、入参/响应契约、无状态边界与全部 400 守卫**不变**,变的只有「cohort 内那批行从哪来」。

**定位总体改读同一份快照**:不再调用节点作用域查询 `listRankings`,而是读 `/rankings` 的同一份全量快照,再用 `api-client` 的同一个 `cohortSlugs` 切出 cohort。**这不是实现细节,是可观察行为的变更**:`rank` / `total` / `percentile` / `neighbors` 全部由这批行决定。

**祖先来源随之改变**:原先本端点沿**物化闭包** `category_closure` 取 cohort 成员,榜单侧沿快照的 `parentSlug` 链取。两条来源只在「每次 re-parent 都重建闭包」时一致,而没有任何机制保证——症状会是**比价卡上的名次与榜单不一致**,且是静默的。改读同一份快照后,两侧共用 `parentSlug` 链这一条来源,该分叉风险消失。`/categories` 不再下发 `rankableCount`,因此没有第二个服务端计数需要与该总体对齐。

**行准入必须与榜单同一道门**:快照行在下发前经下发契约逐行准入(见 `persistence`)。`/compute` 必须看到**准入后**的同一个集合——被榜剔除的行若仍计入这里的 `rank` 与 `total`,「定位与榜单同一总体」这条保证就是假的,而它正是本次改动要买的东西。

**取数上限取消**:原先为控制读取量设了 `COMPUTE_COHORT_FETCH_MAX`,其自身注释已自陈越过上限会「silently under-count」。快照是全量对象,不存在需要截断的分页游标,该上限一并移除。**不得**以任何形式重新引入按行数截断的定位总体——一个被截断的总体产出的是貌似成功的错 `rank`。

**`per_100g` 的 400 不变,但理由改述**:原理由是「定位读复用的 `/rankings` 查询是 per100ml-only 构造」。该查询已不在路径上,但快照本身仍是 per100ml-only(入榜两门含 `per100ml IS NOT NULL`),故结论不变:`cohortAxis` 解析为 `per100g` 时**必须** `400`,**禁止**进入定位。解禁条件改述为「快照扩出重量轴之后」,不再挂在 `listRankings` 上。

**`CATEGORY_SLUGS` 校验不变**:`category` 仍必须先对照编译期派生的品类 slug 全集校验(非成员 → `400 未知品类`),再经 `resolveComparableUnitStatic` 守卫可比性。该约束原挂在 `rankings-api` 的参数边界需求下,那条需求随参数面移除,**本端点是其唯一存续消费方**,故约束迁入本规范:该校验集**必须编译期派生自 `packages/db` 的 `CATEGORY_NODES`**,禁止手写第二份枚举、禁止运行期查 `tag` 表。

**守卫必须用编译期静态解析器,禁止用运行期 `resolveComparableUnit`**:cohort 守卫必须用纯同步、编译期派生自 `packages/db` 的 `CATEGORY_NODES` 的 `resolveComparableUnitStatic(slug)`(沿 `parentSlug` 求 is-a 继承、不查 `tag` 表),**禁止**复用 repository 的运行期 `resolveComparableUnit`(它 round-trip `tag` 表)。理由是一条关键正确性约束:合法但 DB 暂未 seed 的 cohort slug(如 `beer`,迁移先于 seed 的窗口里 `tag` 行尚不存在)经**运行期**解析得 `null` → 被守卫误判 `400`,与「合法 slug 但未 seed → `200` + 空 neighbors、禁止误报 `400`」直接冲突;而**静态**解析器对 `beer` 恒为 `per_100ml`(与 DB seed 状态无关)→ 放行 → 快照零命中 → `200` 空总体,对 `alcohol`/`beverage` 恒为 `null` → `400`,两侧契约同时满足。该禁令原载于 `rankings-api` 与 `persistence`,两处均随本变更改写/移除,故迁入本规范。repository 的运行期 `resolveComparableUnit` 仍用于打标签管线,不受影响。

**读失败仍是 500**:快照读抛错 → `500 persistence-error`,不重算、不降级为空总体——空 `neighbors` 是「该 cohort 确实无同类」的信号,拿它掩盖一次读失败会把故障渲染成正常结果。

**静态合法但快照未含该节点时映射为空总体**:`category` 先经编译期 slug 全集与静态可比轴守卫;二者通过后,若同一快照的 `categoryNodes` 尚无该 slug,`cohortSlugs` 的未知节点拒绝态在本端点必须映射为零成员 cohort。这只覆盖迁移先于 seed / 陈旧空快照窗口;不在静态全集内的输入仍是 `400 未知品类`。

**邻居名次取完整 cohort 的 1-based 位次**:`neighbors[].rank` 不是返回切片内的序号。每个邻居的 rank 必须等于它在完整、服务端下发顺序的 cohort 中从 1 开始的位置,与榜单从同一快照派生的 rank 一致。

#### 场景:足够的结构化输入返回单价与定位

- **当** 客户端提交轴与 cohort 一致、字段齐备的结构化输入
- **那么** 返回确定性单价与 `rank` / `total` / `percentile` / `neighbors`;计算管线与响应契约不变
- **那么** 定位所用的行来自 `/rankings` 的同一份快照、经同一个 `cohortSlugs` 切出、且是行准入后的集合
- **那么** 每个 `neighbors[].rank` 必须是该行在完整 cohort 中的 1-based 位次,不得按邻居切片重新从 1 编号

#### 场景:输入集不足返回 400 并指明缺字段

- **当** 结构化输入缺必要字段
- **那么** `400` 并指明缺哪个字段;不变

#### 场景:价格非正或不自洽返回 400（uncomputable 不静默 200）

- **当** 价格非正或输入不自洽
- **那么** `400`;不得静默 `200`;不变

#### 场景:跨轴 / 跨 cohort 不可比返回 400

- **当** 输入轴与 cohort 轴不一致,或 `category` 是跨 cohort 节点(`resolveComparableUnitStatic` 为 `null`)
- **那么** `400`,文案指明该品类的比价单位轴;不变
- **当** `category` 不在编译期派生的 slug 全集内
- **那么** `400 未知品类`(区别于跨 cohort 文案);该 slug 全集必须编译期派生自 `CATEGORY_NODES`,禁止手写第二份枚举或运行期查 `tag` 表

#### 场景:本期 per_100g cohort 返回 400（不静默给错定位）

- **当** `cohortAxis` 解析为 `per100g`
- **那么** `400`「暂不支持按重量(每100g)比价」;**禁止**进入定位
- **那么** 理由改述为「快照本身是 per100ml-only(入榜两门含 `per100ml IS NOT NULL`)」;原理由「定位读复用的 per100ml-only 查询」所指的 `listRankings` 已不在本端点路径上。解禁条件是快照扩出重量轴,不再挂在该查询上

#### 场景:合法但未 seed 的 slug 放行而非误报 400

- **当** `category` 是 seed 全集内、静态解析单位非空的 slug(如 `beer`),而 DB 尚无对应 `tag` 行(迁移先于 seed 的窗口)
- **那么** 守卫必须放行(静态解析器与 DB 状态无关);即使 `cohortSlugs` 因快照中缺该节点返回未知节点拒绝态,本端点也必须把它映射为零成员 cohort → `200` + 空 neighbors,**禁止**误报 `400 未知品类`
- **当** 有人改用运行期 `resolveComparableUnit` 做该守卫
- **那么** 该 slug 会解析得 `null` 并被误判 `400`——这正是禁令存在的理由

#### 场景:该 cohort 无同类时返回空 neighbors 而非报错

- **当** 该 cohort 在快照中无成员
- **那么** 返回空 `neighbors`、`total = 0`、`percentile = 0`,`200`;不得 404
- **当** 快照读本身抛错
- **那么** `500 persistence-error`;**不得**降级为空总体——那会把一次读故障渲染成「该品类暂无同类」

#### 场景:无状态、no-store、schema 客户端安全

- **当** 检查本端点的副作用与缓存头
- **那么** 不写库、不调 LLM、`Cache-Control: no-store`;契约经 `api-client` 共享 schema 校验;不变
- **那么** 读全量快照不构成状态:它是一次只读取数,不缓存于本端点、不跨请求复用

#### 场景:定位总体与榜单总体不得分叉

- **当** 同一 cohort 同时被榜单派生和被本端点定位
- **那么** 两者的行集合必须相同——同一份快照、同一个 `cohortSlugs`、同一道行准入门
- **当** 有人提议为控制读取量给定位总体加行数上限
- **那么** **禁止**:截断后的总体产出貌似成功的错 `rank`,而调用方无从分辨
