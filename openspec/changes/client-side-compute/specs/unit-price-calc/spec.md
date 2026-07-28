## 新增需求

### 需求:单价计算链路的运行时依赖必须保持 Zod-free

`packages/core` 的确定性计算(`calculate`)与 tier1 解析**必须**可在**禁用 `eval` / `new Function` 的运行时**(微信小程序等)执行。为此,从这两个入口出发、沿**值导入**可达的传递闭包**必须不含 `zod`**。

该约束的对象是**运行时依赖**,不是类型引用:对 `types.ts` 等带 Zod 的模块**只允许** `import type`(编译期擦除、不进产物),**禁止**值导入。`packages/core` **必须**为这一算术子集提供独立的子入口(barrel 只 re-export 闭包内模块),**禁止**要求客户端从根入口 import 后依赖打包器 tree-shaking 摇掉 Zod——weapp 打包链路对 Zod 的处理已被证明不可靠(现代语法转译会破坏 class、Zod 的 JIT 用 `new Function` 撞 eval 禁用),而摇树失败的表现是**运行时崩溃**、不是编译报错。

这条性质**当前已经成立**(闭包恰为 `calculator` / `consistency` / `parser` / `tiers` / `units`),但**没有任何守护**:把某个 schema 从 `import type` 提成值导入、或在 `units.ts` 里加一行 Zod 校验,TypeScript、lint 与既有单测**全部不报错**,而客户端会在 weapp 上崩。故本约束**必须**配一个可执行检查,**禁止**只靠 review 或注释维持。

服务端(`apps/api`)**不受**本约束限制:它可以继续从根入口使用 core 的全部导出,包括带 Zod 的 schema。

#### 场景:算术子入口的值导入闭包不含 zod

- **当** 从算术子入口的 barrel 出发,沿**值导入**(`import ... from`,不含 `import type`)递归遍历 `packages/core` 内的传递依赖
- **那么** 闭包内**必须**不出现对 `zod` 的导入;出现即**必须**使检查失败

#### 场景:把类型引用改成值导入必须被检查拦住

- **当** 有人把闭包内某模块对 `types.ts` 的 `import type` 改成值导入(或在闭包内新增任何 Zod 依赖)
- **那么** 上述检查**必须**失败;**禁止**依赖 TypeScript 编译、lint 或既有单测发现该改动——它们对此均不报错

#### 场景:服务端仍可使用带 Zod 的导出

- **当** `apps/api` 从 `@unit-price/core` 根入口 import `ParsedSpecSchema` / `category-rules` 等带 Zod 的导出
- **那么** 这**必须**合法、不受本约束限制;本约束只作用于算术子入口的闭包
