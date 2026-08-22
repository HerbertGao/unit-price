# category-tree-api 规范

## 目的
定义公开只读品类树端点及其与 rankings 快照 `categoryNodes` 的同形约束，使客户端只凭 `rankable` 判断入口，并从同一快照派生节点行数而不维护第二计数源。

## 需求

### 需求:GET /categories 只读品类树浏览接口

`apps/api` 必须提供 `GET /categories`,返回 store-agnostic 的 category is-a 树。只读:不写库、不调 LLM、不触发后台任务、不出站 fetch;治理豁免。DB 不可达时复用既有 `persistence-error`(500),不新增错误码。

**端点保留,节点投影与快照完全同源**:品类树已随 `/rankings` 快照同体下发,浏览路径不再单独请求本端点。本端点保留为只读 API;其 `nodes` 必须与同一数据状态下快照的 `categoryNodes` 逐字相同并由同一段投影逻辑产出,不得维护第二种节点形状。

**只透 category 轴**:仅含 `kind=category` 节点,不透出 `attribute` / `brand` / `product_line`。

**响应 schema**:由 `CategoryTreeResponseSchema`(居 `@unit-price/api-client`)定义。每节点只含 `slug` / `name` / `parentSlug` / `comparableUnit`(经 is-a 继承解析,一次性加载后在内存沿 parent map 解析,不得逐节点串行)/ `rankable`(= `comparableUnit !== null`)。

**移除 `rankableCount`**:服务端不再下发节点计数。当前客户端已持有全量快照,需要节点行数时必须从同一快照按 cohort 派生;不得恢复一个沿物化闭包计算、可能与实际榜行数漂移的第二计数来源。客户端判定节点是否可点进必须只用 `node.rankable`;对 `rankable=false` 节点拒绝派生视图。

**未播种退化态**:taxonomy 未播种时返回 `200 { nodes: [] }`,不得报错。此窗口内快照的 `categoryNodes` 同样为空,客户端按「空树 → 空态」处理,不得判为未知品类。

#### 场景:返回完整 category is-a 树（含乳品子树）、不含其它标签轴

- **当** 请求 `GET /categories`
- **那么** 返回全部 `kind=category` 节点,不透出其它标签轴
- **那么** 该节点数组必须与同一数据状态下快照的 `categoryNodes` 逐字相同,且任一节点均不得含 `rankableCount`

#### 场景:comparableUnit 继承 + rankable 收敛（软饮/乳品/酒种叶可点进，root/酒类父不可点进）

- **当** 解析任一节点的 `comparableUnit`
- **那么** 沿 `parent_id` 向上取最近非空祖先,不得透出未继承的裸列值
- **那么** 软饮 / 乳品 / 各酒种叶得 `per_100ml`、`rankable=true`;root `饮料` 与 `酒类` 父得 `null`、`rankable=false`

#### 场景:消费契约用 rankable 判榜入口（酒类父 rankableCount>0 但不可点进）

- **当** 客户端判定某节点是否可点进
- **那么** 必须只用 `node.rankable`;节点契约中已不存在 `rankableCount`
- **那么** 对 `rankable=false` 节点,客户端拒绝派生视图

#### 场景:可点进节点 rankableCount 与其 cohort 榜基数一致

- **当** 客户端需要任一 `rankable=true` 节点的实际榜行数
- **那么** 必须从同一份快照按该节点派生并计数,服务端不得下发或承诺 `rankableCount`

#### 场景:可点进节点闭包下无可排名成员时计数为 0、不报错

- **当** 某 `rankable=true` 节点在同一份快照中无可排名成员
- **那么** 客户端派生行数为 `0`,节点仍照常返回且服务端不报错;响应中不得出现 `rankableCount`

#### 场景:taxonomy 未 seed 时返回空树而非报错

- **当** DB 已连但 taxonomy 未播种
- **那么** 返回 `200 { nodes: [] }`,不报错;快照的 `categoryNodes` 同样为空
- **那么** 客户端必须把「空树」与「slug 不在树中」分开:空树是合法退化态、渲染空态,不得报成「该分类不存在」,更不得整屏报错
