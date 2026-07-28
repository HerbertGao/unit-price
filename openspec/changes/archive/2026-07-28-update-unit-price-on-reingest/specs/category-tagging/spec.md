## 修改需求

### 需求:现有库存必须 backfill 打标签(不重放 ingest、单归属收敛、幂等)

**必须**对已落库的 `product` 跑 backfill:经打标签管线产出品类归属(叶 `product_tag` / `pending_category_tag_id`)、重算 `rankable`、补 `category_closure` 命中。backfill **必须**经一个受控入口落地(迁移 / 脚本 / 鉴权运维端点之一),**禁止**重放 `/ingest`——理由是它**会覆写** `title`/`price`/`captured_at` 为重放观测并触发后台 tier2(而非「不覆写」:`unit_price` 的派生值现在也随重报刷新,见 `persistence`「product 必须按去重键收敛」,故旧的 first-write-wins 理由已不成立)。

- **写路径三态 reconcile(单归属收敛 + 落叶清 pending)**:每次写品类归属,**必须**把三态字段(`kind=category` 叶 `product_tag` 与 `pending_category_tag_id`)**整体收敛到本次裁决**,使任一时刻商品恰落三态之一、**绝不**出现「有叶 ∧ pending 非空」的越界态:
  - 裁决 = **叶**:先删该 `product` 既有 `kind=category` 叶 `product_tag`、插新叶,**并置 `pending_category_tag_id=NULL`**(落叶必清 pending,对齐 taxonomy §二「转为正式叶标签、清 pending」)——规则升级改判 A→B 后只剩叶 B、不残留 A;
  - 裁决 = **待细化**:删既有 `kind=category` 叶、写 `pending_category_tag_id`(非叶节点);
  - 裁决 = **待人工**:删既有 `kind=category` 叶、置 `pending_category_tag_id=NULL`。
  (只动 `kind=category` 轴,**不误删** attribute / brand / product_line 正交标签。)
- **幂等**:同一数据快照重跑结果一致——`product_tag` `(product_id, tag_id)` 唯一防重复;仲裁为纯函数(同输入同输出);`rankable` / `pending` 为覆写、收敛到同值。

#### 场景:现有商品获得品类归属与属性标签
- **当** 对现有库存(全量 `product`,含 per100ml 不可算行;规模以运维当次普查为准)跑 backfill
- **那么** 可判定项获叶 category + 适用 attribute 标签且 `category_closure` 填充(含到 root);`rankable` 按规则重算

#### 场景:不可判定项落待人工、不强归
- **当** backfill 遇 tier1 与 store-map 都无确定叶的商品
- **那么** 其**品类归属留空** + 待人工,**禁止**强归、**禁止**改 `product.category` 列

#### 场景:规则升级改判后单归属收敛(无残留旧叶)
- **当** tier1 规则升级使某商品从叶 A 改判叶 B,随后重跑 backfill
- **那么** 该 `product` 的 `kind=category` 叶 `product_tag` **必须**只剩叶 B、**不得**残留叶 A;`rankable` 随之重算

#### 场景:待细化命中叶后清 pending、落已分类态(无越界)
- **当** 一个「待细化」商品(`pending_category_tag_id` 非空、无叶)经规则升级 / 人工命中叶
- **那么** 写叶的同时 `pending_category_tag_id` **必须**置 `NULL`,该商品恰落「已分类(叶)」态,**禁止**出现「有叶 ∧ pending 非空」的越界态;反向(叶 → 待人工 / 待细化)亦**必须**删除既有叶,不留残叶

#### 场景:backfill 重跑幂等
- **当** 对同一数据快照重复跑 backfill
- **那么** 结果**必须**一致:不重复挂同一 `(product_id, tag_id)`、归属与 `rankable` 收敛到同值

#### 场景:三态写归属必须原子收敛(无部分写越界态)
- **当** 写一次品类归属(经 reconcile:删旧叶 + 挂新叶/属性 + 设 pending + 重算 rankable)
- **那么** 这组写**必须**在单事务(sqlite)/ 批(D1)内**整体提交或整体回滚**,即便中途失败也**禁止**留下「有叶 ∧ pending 非空」的越界态;且原语**必须**在写前校验 kind(叶位只接 category 叶、pending 只接非叶 category、属性非 category),非法 slug / 缺失 product → 抛错而非静默假成功

#### 场景:本期 backfill 对 store-map 惰性、tier1 为活跃路径
- **当** 本期对现有库存跑 backfill
- **那么** 该场景描述的是本能力落地当期的状态。**其前提此后已被 `add-store-map-native-id` 变更取代**:ingest 现已采集并持久化 `product_raw.native_category_id`,backfill 会读取它并把 store-map 作为**活跃**分类路径(tier1 关键词规则不再是唯一路径)。本变更**不改动**该管线,此处仅订正这条已失真的陈述,以免归档时把它重新祝福为现状

