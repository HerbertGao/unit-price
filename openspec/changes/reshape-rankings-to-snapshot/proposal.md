## Why

榜单把排序、分页、品类过滤、搜索都放在服务端,于是每个参数组合是一个独立 CDN 缓存键(实测 17 条预热 URL)。代价:数据变更后要逐键 purge + 预热(曾漏刷导致缺新品的榜被缓存一天);品类切换 / 翻页 / 搜索各是一次跨境往返(~1.8s);各键独立过期,不同品类可能来自不同时刻。

榜单全量 389 行。整表一次下发在当前量级可行(实测 376 行约 130 KB 原始 / 20 KB gzip),可把缓存键收敛为 1,并让派生视图变成零网络的本地操作。

`apps/` 只有 `api` 与 `miniapp`,`/rankings` 没有其它消费者;小程序尚未正式发布,API 亦未向第三方开放,因此不存在已发布消费者的兼容窗口。故直接改造现有端点、不新增版本端点。

## What Changes

- **BREAKING**:`GET /rankings` 改为**全量快照**:不接受参数,返回 `{ rows, categoryNodes, excluded }`。
- 行契约:移除 `rank`(读时投影,无参时无定义);新增 `categorySlugs: string[]`(该行挂的全部 category slug,应对同商品双叶);新增 `id`(承载 `unit_price.id`,作稳定行身份供列表 key,**不是排序键**)。
- **BREAKING**:**无排序键、无叶性门、无服务端节点计数**。客户端不排序(过滤与切片保序,继承服务端下发的序);归属判据是「任一 slug 是目标节点或其后代」,对叶与非叶一致。`GET /rankings` 的 `categoryNodes` 与 `GET /categories` 均移除 `rankableCount`;需要节点行数的客户端从同一份快照本地计算,不再维护第二个可能漂移的计数来源。理由见 design 的 D3 / D4 / D9。
- taxonomy 与行**同体下发**(避免两个独立 TTL 对象版本错位)。
- `packages/api-client` 新增快照契约与本地派生能力(cohort 过滤 / 分页 / 搜索),不含排序。
- `apps/miniapp` 改为一次取快照 + 本地派生;两个错误位收敛为一个;端上缓存换单键。
- `POST /compute` 的 cohort 定位改用同一快照构造与祖先规则;同一数据库状态下与榜同总体,不承诺跨 CDN/端上缓存版本的请求逐字同步。
- CDN 预热 URL 由 17 条收敛为 2 条,并配置边缘 query 归一化。

## Capabilities

### Modified Capabilities

- `rankings-api`:`/rankings` 由分页视图改为全量快照;移除 `category`/`q`/`limit`/`offset`。
- `persistence`:新增全量快照查询;`listRankings` 随 `/compute` 改读快照而**消费者归零**。
- `api-client`:快照契约 + 本地派生能力(不含排序)。
- `category-tree-api`:移除 `rankableCount`;节点是否可进入榜单仍只由 `rankable` 表达,需要行数的客户端从快照派生。
- `miniapp`:榜单数据层改为快照 + 本地派生;分页、搜索、错误位与端上缓存口径随之改写。
- `deployment`:缓存与预热 URL 集收敛;新增形状变更部署的刷新要求。

## 非目标

- 不做端上单价计算(`per100ml` 仍取存储值)。
- 不做跨 cohort 混排:快照是传输单位,cohort 是展示单位。
- 不动入库、打标签、cohort 规则表归属。
- 不实现规模超限后的自动降级(阈值与回退路径见 design)。
- 不实现 `generatedAt` / 服务端下发落地 cohort(理由见 design 快照字段表「不在表内、且刻意不做的」)。
- 不在本变更中实现或调整 `/compare`、Redis 解析缓存、首发可见品类、陈旧价格文案、API 第三方开放度或小程序软启动策略;这些属于独立的路线或发布准备变更。

## Impact

- **发布单元**:服务端与 miniapp 在同一变更内落地。因小程序尚未发布且 API 未向第三方开放,不存在旧客户端审核窗口;但 CDN 可能仍缓存旧响应形状,故发布顺序为源站部署 → purge `/rankings*` 与 `/categories` → query 归一化 → 预热并验形两个端点 → 提交首版小程序。
- **API**:`/rankings` 改为快照对象、`/categories` 移除 `rankableCount`,均为破坏性变更;`/compute` 响应契约不变、cohort 数据源改变。
- **缓存**:榜单相关键 17 → 1(`/categories` 仍在,合计 2 条预热)。
- **规模**:389 行;实测 376 行快照约 130 KB 原始 / 20 KB gzip / 15 KB brotli,一次性下发无体积风险。失效阈值见 design。
- **合规**:只读、不抓取、不新增出站、不触 LLM。
