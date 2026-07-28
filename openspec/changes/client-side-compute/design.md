## Context

`POST /compute` 承担两件独立的事:

1. **算术** —— 把结构化输入映射成 `ParsedSpec`,调 `packages/core` 的 `calculate()` 得单价 + `formula`;
2. **定位** —— 在所选 cohort 的榜单里给出 `neighbors`(同类邻居行)。

第 1 件是纯函数,第 2 件必须读库。当前二者绑在同一个请求里,于是**纯算术也要付一趟跨境往返**。

`packages/api-client/src/compute.ts` 的 D3 决策禁止该模块 import `@unit-price/core`,并由 `compute.test.ts` 的架构测试焊死,理由是 weapp 的两个已知坑(现代语法转译弄坏 Zod class;Zod JIT `new Function` 撞 eval 禁用)。**这两个坑的成因都是 Zod**,而算术链路不碰 Zod —— 已用闭包扫描验证(见 D3)。

`packages/core/package.json` 当前只导出根入口 `"."` → `dist/index.js`,而 `index.ts` re-export 了带 Zod 的 `types.ts` / `category-rules.ts`。**从根入口 import 必然拖进 Zod**,与是否 tree-shaking 无关地不可靠(weapp 走 Taro 的 esbuild-vendor 路径,不能指望摇干净)。

## Goals / Non-Goals

**Goals:**
- 结构化输入的单价与 `formula` 在端上**同步**产出,零网络、离线可用。
- 本地结果与 `/compute` 结果**逐字相同**,且这一点由对照测试守住。
- 「算术链路 Zod-free」从一条偶然成立的性质变成**有 runnable check 的契约**。

**Non-Goals:**
- 不做 tier2(LLM)本地化。
- 不改 `/compute` 的请求/响应形状,不删该端点。
- 不把 `types.ts` / `category-rules.ts` 送进客户端运行时。
- 不做榜单排序本地化。

## Decisions

### D1:用显式子入口暴露算术,不靠 tree-shaking

`packages/core` 增加子入口(如 `@unit-price/core/calc`),其 barrel **只** re-export 闭包内的 5 个模块;根入口 `"."` 保持原样不动(服务端继续用它)。

**否决的替代方案**:
- **依赖 tree-shaking 从根入口摇掉 Zod** —— weapp 打包链路已被证明会对 Zod 做出反直觉的事(class 被转坏、JIT 撞 eval 禁用),把正确性押在打包器的摇树精度上,失败模式是**运行时崩溃**而非编译报错。显式子入口把「什么能进客户端」变成**可静态检查的边界**。
- **把算术复制一份到 `api-client`** —— 直接违反「schema/计算单一事实源」,两份实现必然漂移,且漂移方向是「算出不同的钱」。

### D2:先出结果,再补定位

本地算完**立即**渲染单价 + `formula`;`neighbors` 仍走 `/compute`,异步补齐。UI **必须**在定位未到达时就是可用的完整结果,而不是骨架屏——定位是增益信息,不是结果的组成部分。

`/compute` 请求照发,其响应里的 `unitPrice` 与本地已算出的值应当相同;**以本地值为准渲染,不因响应到达而重绘数字**(避免同一个数字先后跳变)。二者不同即为缺陷信号,应记日志而非静默采信任一方。

### D3:Zod-free 靠 runnable check 守,不靠 review

「算术链路不引入 Zod」是**一条会被无声破坏的性质**:任何人把 `types.ts` 里某个 schema 从 `import type` 提成值导入,或在 `units.ts` 加一行校验,客户端就会在 weapp 上崩——而 TypeScript、lint、现有单测**全都不报错**。

故本变更**必须**留一个测试:从子入口 barrel 出发遍历**值导入**的传递闭包(`import type` 不计,编译期擦除),断言闭包内**无 `zod`**。该检查已验证当前闭包恰为 `{calculator, consistency, parser, tiers, units}`。

同时把 `compute.test.ts` 现有的「禁止 import `@unit-price/core`」断言改写为「禁止 import core 的**根入口**与带 Zod 的模块」——**不是删掉它**。原断言保护的是真实风险,只是边界画粗了;删掉等于把守卫一起扔了。

### D4:cohort 合法性仍由服务端裁决

`resolveComparableUnitStatic` 与 `CATEGORY_SLUGS` 在 `apps/api/src/routes.ts`,且 cohort 规则表在带 Zod 的 `category-rules.ts` 里(slug 集合以 `z.enum` 承载)。**本变更不搬它**:客户端只在**已知合法**的品类上算数,跨 cohort 的 `400` 判定仍是服务端职责。

代价是「选了个跨 cohort 品类」这个错误仍要等一趟网络才知道。接受——它是错误路径,不是主路径;把规则表抽成 Zod-free 纯数据属于另一件事。

## Risks / Trade-offs

- **[两条路径算出不同的钱]** → 二者**共用同一份 core 代码**、不是重写,结构上不可能漂移;仍须一组对照测试(同一批输入,本地结果 === `/compute` 响应的 `unitPrice`)作为回归网。
- **[weapp 包体增大]** → 引入 5 个模块的算术子集。CI 已有 `pnpm --filter miniapp build:weapp` 步骤,验收须记录产物大小增量;若超出预期再评估。
- **[子入口在某些打包器下解析失败]** → 子路径 exports 是标准 Node 特性,但 Taro/weapp 链路对 `exports` 字段的支持须**实测**而非假定;失败即回退到「从深路径直接 import 具体文件」。这是本变更最需要早验的一点。
- **[「以本地值为准」掩盖服务端缺陷]** → 若服务端算错,端上不再展示它、问题变隐形。故二者不一致**必须**留日志,不能静默丢弃。

## Open Questions

- 子入口命名与粒度:一个 `./calc` 够,还是 tier1 解析要单独一个?取决于小程序是否也要本地跑 tier1(粘贴标题即时解析),而那属于 `/parse` 的归宿问题、不在本变更内。
