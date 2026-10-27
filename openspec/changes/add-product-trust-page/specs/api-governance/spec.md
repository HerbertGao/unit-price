## ADDED Requirements

### Requirement: GET /products/:id 为受保护集合之外的公开只读端点

`GET /products/:id` MUST 豁免公共治理（鉴权、限频、用量），与 `GET /categories` 相同。它 MUST NOT 改变受保护集合 `{/parse, /contribute, /ingest, /ingest/batch}`，也 MUST NOT 挂 admin 鉴权。

#### Scenario: 不带 key 时放行且不写治理 KV

- **WHEN** 客户端不带鉴权头请求一个存在的信任页 id，且公共治理已配置
- **THEN** 请求得到 200，且不因缺 key 返回 401，也不写入限频或用量

#### Scenario: 豁免不放开受保护端点

- **WHEN** 同一应用上对 `/parse` 发起缺 key 请求
- **THEN** `/parse` 仍返回 401 `auth-missing`
