## ADDED Requirements

### Requirement: 产品信任读端点不得进入长 TTL 边缘缓存

`GET /products/:id` 的成功响应 MUST 发送 `Cache-Control: no-store`。它 MUST NOT 使用 `PUBLIC_CACHE_CONTROL`，MUST NOT 加入定时预热目标。预热目标仍只有 `/rankings` 与 `/categories`。错误响应 MUST NOT 带缓存头。

#### Scenario: 成功响应为 no-store

- **WHEN** `GET /products/:id` 返回 200
- **THEN** `Cache-Control` 为 `no-store`

#### Scenario: 预热清单不增加按 id 的 URL

- **WHEN** 检查定时预热的目标 URL
- **THEN** 清单仍只有 `/rankings` 与 `/categories`，没有 `/products/`
