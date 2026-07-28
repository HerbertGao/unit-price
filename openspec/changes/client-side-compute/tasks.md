## 0. 先验(必须最先做,结论会推翻后续设计)

- [ ] 0.1 **实测 Taro/weapp 对 `exports` 子路径的支持**(`apps/miniapp`):在 `packages/core` 加一个最小子入口(哪怕只导出一个常量),从 miniapp import 后跑 `pnpm --filter miniapp build:weapp` 并在真机/devtools 验活。**这是 design 里标记为「最需要早验」的一点**:不支持则整个 D1 要退回「从深路径直接 import 具体文件」,后续任务的形态随之改变。**不通过就先停下来改 design,不要硬推**
- [ ] 0.2 记录 baseline:当前 weapp 产物大小(`pnpm --filter miniapp build:weapp` 后的包体),供 3.2 对比增量

## 1. core:Zod-free 算术子入口(`packages/core`,纯函数无 IO)

- [ ] 1.1 新建算术 barrel,**只** re-export 运行时闭包内的模块(`calculator` / `consistency` / `parser` / `tiers` / `units`);根入口 `"."` 的导出**保持不变**(服务端继续用)
- [ ] 1.2 在 `package.json` 的 `exports` 增加该子路径(保留 `"."`),`types` / `import` 两条都配齐
- [ ] 1.3 **闭包守卫测试**(对应 `unit-price-calc` 的两个场景):从子入口 barrel 出发,沿**值导入**(`import ... from`,**排除** `import type`)递归遍历 core 内部依赖,断言闭包内无 `zod`。测试**必须**同时覆盖反向用例——构造一个含 Zod 值导入的桩模块,断言检查会失败(否则一个恒真的检查看起来也是绿的)
- [ ] 1.4 补/核对算术子集的单测仍全绿(脏标题样本集不受影响,子入口只是换了打包边界、不改逻辑)

## 2. api-client:本地计算(`packages/api-client`)

- [ ] 2.1 导出本地计算函数:入参与 `ComputeRequest` 同构,内部映射成 `ParsedSpec` 后调 core 子入口的 `calculate()`;**禁止**在本包重写任何单位换算/公式
- [ ] 2.2 映射与「输入集是否足够」的判定**必须**与 `apps/api` 的 `/compute` 处理器逐字同构 —— 实现前先逐行读 `apps/api/src/routes.ts` 的 `/compute` 分支(`meetsComputeRequiredSet` 那段),把差异清单列出来再动手
- [ ] 2.3 不可计算态:输入集不足 / `formula === null` 时返回明确的不可计算态 + 原因,**禁止**返回会被渲染成单价的数字;口径与 `/compute` 的对应 `400` 一致
- [ ] 2.4 **对照测试**(对应 api-client 首个场景):一组结构化输入,断言本地结果的单价与 `formula` 与 `/compute` 处理器产出**逐字相同**。直接在测试内调用 `apps/api` 的处理逻辑或复用其映射,**不打网络**
- [ ] 2.5 改写既有架构测试:`compute.test.ts` 的「禁止 import `@unit-price/core`」→「禁止 import core **根入口**及带 Zod 的模块」。**禁止**直接删除该测试;同时断言算术子入口是**允许**的
- [ ] 2.6 单测:本地计算不发起网络请求;离线可用

## 3. miniapp:两段式结果卡(`apps/miniapp`)

- [ ] 3.1 比价表单页改为提交即**同步**渲染单价 + `formula`;`/compute` 请求照发但只用于补 `rank`/`total`/`percentile`/`neighbors`。**数字以本地值为准,禁止因响应到达而重绘单价**
- [ ] 3.2 定位失败/离线降级:定位区呈现中性说明,**禁止**隐藏单价或把整卡渲染成错误态(对应新增场景)。同时记录 weapp 产物大小,与 0.2 的 baseline 对比并写进验收记录
- [ ] 3.3 本地值与 `/compute` 响应不一致时**记日志**(不静默采信任一方);确认既有 `400` 文案呈现路径(跨轴不可比/未知品类)不受影响
- [ ] 3.4 真机验证:填表→单价瞬时出现(无 loading)→定位随后补上;飞行模式下单价仍出、定位降级

## 4. 收口验证

- [ ] 4.1 `pnpm -r build` + `pnpm -r test` 全绿;`pnpm --filter miniapp build:weapp` 通过(CI 已含该步)
- [ ] 4.2 **归档试跑**:把 `openspec/` 复制到临时目录跑 `openspec-cn archive client-side-compute -y`,确认无硬中止(`validate --strict` 抓不到「MODIFIED 改了场景标题」这类坑)
- [ ] 4.3 核对 `apps/api` 与公共端点**零改动**(`/compute` 契约不变、路由表 diff 为空)
