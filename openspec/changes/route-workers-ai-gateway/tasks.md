## 1. 网关 id

- [x] 1.1 `apps/api`：单一常量 `unit-price`。binding 的 `AI.run` 第三个参数带 `gateway: { id }`，覆盖生成式包装与 Clef 的 `runWorkersAi`。保留 `reasoning_effort: "none"` 与 `createAI` 需要的其余 run 选项。
- [x] 1.2 REST：`createAI({ gateway })` 与 Clef 的 fetch 都把同一 id 送到 `cf-aig-gateway-id`。不改模型 id、阈值，不新增 secret，不调用网关管理 API。

## 2. 测试与说明

- [x] 2.1 单测断言 binding 路径的网关 id（生成式与 Clef），并断言 REST 头。生成式请求仍断言 `reasoning_effort` 为 `none`。
- [x] 2.2 `docs/architecture.md` 与 `apps/api/README.md` 写明网关已存在、标准账单即可，部署不创建网关、不要求预付 Unified Billing。
