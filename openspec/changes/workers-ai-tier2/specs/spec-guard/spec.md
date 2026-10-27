## ADDED Requirements

### Requirement: Clef 只做闸门与告警

当 tier1 尚未给出确定结论时，系统可以调用 Workers AI `@cf/cloudflare/clef-flash` 回答是否调用生成式解析，以及生成式合并成功后的数量/拼单疑问。Clef 的答案禁止写入 `unitSize`、`quantity` 或任何其他 `ParsedSpec` 字段。tier1 已确定的标题禁止调用 Clef，也禁止调用生成式模型。Clef 失败或未配置不得单独变成解析失败：未配置或调用失败时必须继续进入生成式端口，使缺配置仍表现为该端口的 config-error。

#### Scenario: 低概率跳过生成式解析

- **WHEN** tier1 非确定，且 Clef 对「标题含可抽取规格」的 yes 概率低于 0.35
- **THEN** 系统不得调用生成式解析，必须保留 tier1 spec，并附加说明已跳过生成式解析的 warning，再进入 tier3

#### Scenario: 概率缺失不得跳过

- **WHEN** Clef 没有返回有限概率，或调用抛错
- **THEN** 系统必须继续调用生成式端口

#### Scenario: 复核告警不改写规格

- **WHEN** 生成式合并成功，且 Clef 对数量不一致或多件商品的 yes 概率达到或超过 0.75
- **THEN** 系统必须追加对应 warning，且合并后的 `quantity` 与 `unitSize` 保持不变

#### Scenario: 数量为空不报数量告警

- **WHEN** 合并后的 `quantity` 为 null，即使数量疑问的概率达到告警阈值
- **THEN** 系统不得附加数量不一致 warning

#### Scenario: 确定标题不触模型

- **WHEN** tier1 对应该标题与价格已经给出确定结论
- **THEN** Clef 与生成式端口都不得被调用
