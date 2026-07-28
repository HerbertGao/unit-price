## Why

即时比价的算术**已经在端上具备条件,却仍走一趟跨境网络**。`POST /compute` 的输入是结构化的 `{value, unit}`,服务端做的事就是映射成 `ParsedSpec` 再调 `packages/core` 的 `calculate()` —— 同一份确定性代码,客户端跑出的结果逐字相同。这一趟往返换来的是**零信息**,却要付实测 1.8~2.5s 的等待(经备案域回源跨境)。

`CLAUDE.md` 写着「tier1 正则 + tier3 确定性计算在 `packages/core`,**客户端+服务端双跑**」。客户端那一跑目前没跑起来。

拦路石看上去是 `packages/api-client/src/compute.ts` 的 D3 决策(并由 `compute.test.ts` 的架构测试焊死):**禁止 import `@unit-price/core`**,理由是把 core 拖进 weapp 会重新触发两个已知坑(现代语法转译弄坏 Zod class、Zod JIT `new Function` 撞 eval 禁用)。但核对 core 的真实依赖图后,这条禁令对「算价」这件事**过宽**:

| 模块 | 运行时 Zod | 对 `types.ts` 的引用 |
|---|---|---|
| `calculator.ts`(`calculate`) | 无 | `import type`(编译期擦除) |
| `parser.ts`(tier1) | 无 | `import type` |
| `units.ts` / `consistency.ts` / `tiers.ts` | 无 | `import type` |
| `types.ts` / `category-rules.ts` | **有** | — |

即:**算术链路在运行时完全不碰 Zod**,weapp 的两个坑都踩不到。D3 对「core 这个包整体」成立,不能推广成「算价必须在服务端」。

## What Changes

- **`packages/core` 明确并锁死一条 Zod-free 的算术入口**:`calculate` / tier1 解析及其传递依赖**必须**在运行时不引入 Zod(对 `types.ts` 只允许 `import type`)。这不是新增能力,是把一条**目前成立但无人守护**的性质变成契约 —— 任何人把 `types.ts` 的某个 schema 改成值导入就会静默破坏它,而现有测试抓不到。
- **`packages/api-client` 提供本地计算函数**:接受与 `ComputeRequest` 相同的结构化输入,返回与 `/compute` **逐字相同**的单价与 `formula`。D3 的禁令由「禁止 import core」收窄为「禁止 import core 中带 Zod 的模块」,架构测试同步改写。
- **小程序比价表单页改为本地出结果**:提交即**同步**显示单价 + `formula`,无网络等待、离线可用。
- **`/compute` 端点与契约不变**:它的另一半职责——`neighbors`(同 cohort 内定位)——**必须读库、无法本地化**,继续由端点提供,改为在本地结果显示**之后**异步补齐。

## Capabilities

### New Capabilities
<!-- 无新增独立能力:全部是既有能力的需求级修正。 -->

### Modified Capabilities

- `unit-price-calc`: 新增约束——单价计算与 tier1 解析的运行时依赖**必须**保持 Zod-free,以保证同一份代码可在禁 `eval` 的运行时(weapp)执行。
- `api-client`: 新增本地计算导出;`/compute` 客户端模块的「self-contained、禁止 import core」约束收窄为「禁止 import core 中带 Zod 的模块」。
- `miniapp`: 比价表单页的单价结果由**本地同步计算**产出(不再等待网络);cohort 内定位仍来自 `/compute`、异步补齐,且**必须**在定位到达前就可用。

## 非目标

- **不做** tier2(LLM)本地化。AI 解析永远只在 `apps/api`,这条不动摇。
- **不动** `/compute` 端点的请求/响应形状,**不删**该端点 —— `neighbors` 必须读库。
- **不做**榜单排序的本地化(那是另一个提案的范围)。
- **不把 core 整包塞进 weapp**:`types.ts` / `category-rules.ts` 这两个带 Zod 的模块**仍然禁止**进入客户端运行时。
- **不改** `resolveComparableUnitStatic`(在 `apps/api/src/routes.ts`)的归属,cohort 合法性仍由服务端裁决。
- **不碰**抓取/众包合规面。

## Impact

- **workspace 包**:`packages/core`(可能需要拆子入口 / 加约束测试)、`packages/api-client`(新导出 + 改架构测试)、`apps/miniapp`(表单页交互)。`apps/api` **零改动**。
- **API**:公共端点**零变更**。`/compute` 仍在、契约不变,只是不再是算单价的唯一路径。
- **合规**:不新增出站、不抓取、不触 LLM。**不涉及**合规敏感面。
- **风险面**:两处实现同一算术会漂移——但二者**共用同一份 core 代码**,不是重写;验收须有一组「同输入下本地结果 === `/compute` 结果」的对照测试守住。
- **weapp 包体**:引入 core 的算术子集会增加 bundle,需实测增量(核对 `pnpm --filter miniapp build:weapp` 的产物大小,CI 已有该步骤)。
