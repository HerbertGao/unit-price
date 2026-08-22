## 说明

本清单以当前实现与已修订 proposal/design/specs 为准。勾选项已有代码与测试证据;未勾选项是继续 `/opsx-apply` 时的真实工作。

已接受但不占待办 checkbox 的边界:

- 快照装配当前为顺序三读;现有写路径不删除 `tag`,故撕裂窗口不可达。出现删除 `tag` 的写路径时再改为一致性读。
- 小程序尚未发布、API 未向第三方开放,本次直接改造现有端点,不建设兼容版本端点。
- `/compare`、Redis 解析缓存、首发可见品类、陈旧价格文案、第三方 API 开放与软启动策略不属于本变更。

## 1. 持久层与投影(`packages/db`)

- [x] 1.1 实现无分页全量快照查询,按 `unit_price.id` 聚合全部 category slug 并以 `(per100ml, id)` 全序返回;`board-snapshot.test.ts` 覆盖双叶去重、非叶挂载与空库
- [x] 1.2 对无归属、warnings 损坏、formula 缺失及 wire 行形状错误执行逐项排除并计数;相关 reason 变异测试通过
- [x] 1.3 快照投影透出存储的 confidence/sourceUrl/`COALESCE(lowest_price, price)` 且建立生产 SQL 的 EXPLAIN 基线;投影值与索引变异测试通过
- [x] 1.4 从品类树查询移除 `rankableCount` 与逐节点计数,复用无计数平节点投影;`category-tree.test.ts` 与 `board-snapshot.test.ts` 通过
- [x] 1.5 非 category 的 `parent_id` 不再被静默提升为 root;DB 与真实路由 e2e 验证共享节点 schema 能识别该缺陷
- [x] 1.6 删除零调用的 `escapeLikePattern`、`applyNodeRankingFilter` 与计数查询;db build/test 通过
- [x] 1.7 删除查询计划中的重言式 `product_raw` 断言并校正 `ANALYZE`、`sortKey` 注释;测试显式验证移除 `unit_price` 索引会改变基线

## 2. 共享契约与本地派生(`packages/api-client`)

- [x] 2.1 定义 `{ rows, categoryNodes, excluded }` 快照 schema,从既有榜单行派生无 rank 快照行和带 rank 视图行;schema 单测通过
- [x] 2.2 校验节点 slug 唯一、父引用存在、父链无环、行只引用已知节点;空 taxonomy 合法态单测通过
- [x] 2.3 提供 cohort 过滤、保序分页、ASCII-only 子串搜索与两种可区分拒绝态;派生测试覆盖 Unicode、字面 `%/_` 和非叶挂载
- [x] 2.4 `buildRankingsUrl(base)` 与 jitless `parseRankingsSnapshot(json)` 收窄为单参;URL 与禁 `Function` 守卫测试通过
- [x] 2.5 wire 侧 `excluded.reason` 仅要求非空字符串,生产者新增 reason 不会否决载荷;前向兼容测试通过
- [x] 2.6 categories 与 snapshot 直接复用同一无 `rankableCount` 节点 schema;两种响应的类型与解析测试通过
- [x] 2.7 为本变更涉及的 api-client/API 测试源码建立真实 TypeScript 检查,修复额外实参、悬空 `BoardSnapshotRow` 与 fixture 联合类型错误;CI 门禁通过
- [x] 2.8 `SEARCH_MIN_CODEPOINTS` / `SEARCH_MAX_CODEPOINTS` 已收敛到 api-client 单一来源;miniapp test/typecheck 通过

## 3. 服务端端点(`apps/api`)

- [x] 3.1 `GET /rankings` 忽略全部参数并返回经共享 schema 整体校验的快照;参数逐字同响应、缓存头与治理豁免测试通过
- [x] 3.2 `POST /compute` 读取同一快照、使用同一 cohort 派生、取消截断上限并保持 no-store;定位总体 e2e 通过
- [x] 3.3 行与节点先经共享 schema 准入,坏行/坏节点/引用坏节点的合法行分别计入 `row_shape_invalid` / `node_shape_invalid` / `row_references_invalid_node`,且 `/rankings` 与 `/compute` 共用准入后集合;测试通过
- [x] 3.4 真迁移 + 真 seed + 真 repository + 真路由 + 真客户端派生的 `board-e2e.test.ts` 覆盖总体一致、祖先等价与坏成员排除
- [x] 3.5 `GET /categories` 移除 `rankableCount`,与同一状态下快照 `categoryNodes` 逐字同形;真库 e2e 同时请求两个端点并比较节点数组
- [x] 3.6 `/compute` 测试钉住静态合法但快照缺节点映射为 `200` 空总体,以及 `neighbors[].rank` 为完整 cohort 的 1-based 位次
- [x] 3.7 快照整体校验、compute 整体校验及 categories 响应校验的 5xx 路径均记录错误日志;测试同时断言状态码与日志调用
- [x] 3.8 清理 `routes.ts` 中已退役参数路径、旧重量轴理由与残缺注释;API typecheck/test 通过

## 4. 小程序(`apps/miniapp`)

- [x] 4.1 榜单数据层改为一次取快照后本地 cohort/search/page 派生,触底不发网络请求;hook 纯决策测试通过
- [x] 4.2 缓存改为单键 SWR,读写都经 jitless schema 校验;缓存命中、后台失败保旧值及揭示长度测试通过
- [x] 4.3 落地 cohort 使用具名常量,拒绝态可见,<2 码点搜索匹配空集,列表 key 使用稳定 id;对应变异测试通过
- [x] 4.4 增加 miniapp 源码 typecheck 与 CI weapp bundle 构建;`pnpm --filter miniapp typecheck`、`build:weapp` 通过
- [x] 4.5 miniapp 消费无 `rankableCount` 的 categories 契约,分类树与 compute cohort 只读 `rankable`;测试与 typecheck 通过
- [x] 4.6 miniapp `pretest` 先构建 api-client,单跑测试不再静默消费旧 dist;命令输出验证构建先于测试
- [x] 4.7 `LANDING_COHORT` 与 scope 文案收敛到同一 config 模块,ScopeBar 不再自持第二份字面值;typecheck/build 通过
- [x] 4.8 清理 jitless“只能 devtools 实测”及旧服务端分页/搜索路径注释;miniapp test、typecheck、build:weapp 通过

## 5. 文档、工作流与归档准备

- [x] 5.1 proposal、design 与 7 份 delta specs 已同步:移除服务端节点计数、明确 compute 空总体/rank、开放 wire reason 与首版迁移边界
- [x] 5.2 `.github/workflows/cdn-warm.yml` 的预热目标收敛为 `/rankings` 与 `/categories` 两条,不再枚举 cohort URL
- [x] 5.3 已同步 `docs/architecture.md`、`docs/taxonomy-and-tagging.md`、`docs/backfill-runbook.md` 的全量快照、无计数节点与 CDN 顺序说明
- [ ] 5.4 实际归档时再更新 api-client、rankings-api、miniapp 主 spec Purpose;活跃变更期间主 spec 保持 pre-archive 基线,避免 Purpose 与尚未合并的需求正文冲突
- [x] 5.5 运行 `openspec-cn validate reshape-rankings-to-snapshot --strict` 与 `git diff --check`,两者均为零错误
- [x] 5.6 临时副本 archive 试跑成功;7 个 touched specs 严格校验通过且旧计数/分页正向契约未残留
- [x] 5.7 workspace build、778 个测试、两套测试源码 typecheck、miniapp typecheck 与 weapp bundle 构建全部通过

## 6. 首版发布与生产验活

- [ ] 6.1 将含代码变更放入 feature branch 经 PR/CI 合并 main,确认自动源站部署成功后再继续 CDN 操作
- [ ] 6.2 用人工发布凭据 purge `/rankings*` 全部历史对象与 `/categories`;若 Directory 不覆盖带参对象,按 deployment spec 的 16 条历史路径逐条 File purge
- [ ] 6.3 purge 完成后启用 `/rankings` query-string 归一化,从国内视角确认裸 URL 与带参 URL 命中同一边缘对象
- [ ] 6.4 用 `PushObjectCache` 预热 `/rankings` 与 `/categories`,逐条记录 task id,全部失败时停止发布
- [ ] 6.5 从国内视角验形:`/rankings` 为快照对象、`GET /categories` 的 `nodes` 不含 `rankableCount`、两端点均命中 CDN;任一不符则停止提交小程序
- [ ] 6.6 核对生产两门候选数满足 `rows.length = candidateCount - Σexcluded`,按 reason 排查非零排除但不把其本身判为发布失败
- [ ] 6.7 完成小程序 test/typecheck/build 与真机关键流验证后提交首版审核;服务端自此不得单独回滚为旧数组形状
