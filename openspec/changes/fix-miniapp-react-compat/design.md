## Context

参见 `proposal.md`。`@tarojs/react@4.2.1` 的 peer 是 React `^18`,并固定依赖 `react-reconciler@0.29.0`(peer React `^18.2.0`)。当前 React 19 包可通过 webpack,但 reconciler 在微信运行时读取已不存在的 React 18 内部字段后崩溃;因此“构建绿”不是兼容性证据。

## Goals / Non-Goals

**Goals:**

- 恢复 Taro 4.2.1 官方 peer 范围内的 React 运行时。
- 在 build/dev 两条入口机械阻止同类错配。
- 保持业务代码与 API 契约不变。

**Non-Goals:**

- 不维护 React 19 shim 或补丁 `react-reconciler` 内部实现。
- 不升级整套 Taro 及其插件矩阵。
- 不用微信基础库版本切换掩盖 JavaScript 依赖错误。

## Decisions

**D1 — 使用 React / React DOM 18.3.1 与对应 React 18 类型。** 18.3.1 是 React 18 最后稳定版本,满足 Taro `^18` 和 reconciler `^18.2.0`;两者保持完全相同的 runtime 版本。备选“升级 Taro”不可行:当前最新版 4.2.1 仍声明 React `^18`;备选“React 19 shim”依赖私有内部字段,不可维护。

**D2 — 构建前读取已安装 package metadata 做零依赖检查。** 检查从 `@tarojs/react.peerDependencies.react` 取得支持主版本,比较实际 `react` major,并要求 `react-dom.version === react.version`。该检查由 `build:weapp` 与 `dev:weapp` 共用。无需引入 semver 库:当前 peer 是单一 caret major,若未来 peer 形态超出可解析范围则检查应 fail-closed,提示随 Taro 升级一并更新。

**D3 — 运行时验收独立于编译验收。** 自动门禁覆盖依赖矩阵、test、typecheck 与 bundle;微信开发者工具稳定基础库启动和首页注册作为发布前人工验收,因为 Node/webpack 无法复现小程序 AppService 加载器。

**D4 — Dependabot 忽略 React 生态 semver-major。** 对 `react` / `react-dom` / `@types/react` 只屏蔽 major,让 React 18 patch 仍可更新;Taro peer 支持 React 19 后再删除该策略。构建守卫继续保留,覆盖人工改包与其它自动化来源。

## Risks / Trade-offs

- [React 18 缺少 React 19 新能力] → 当前 miniapp 未使用 React 19 专属 API,且稳定启动优先于未消费能力。
- [peer 字符串未来改变] → 兼容脚本 fail-closed,随 Taro 升级显式调整,不静默放行。
- [开发者工具灰度基础库另有问题] → 先用稳定基础库验收;只有依赖门已通过后才把剩余异常归因于基础库。

## Migration Plan

1. 更新 miniapp React runtime/types 与 lockfile。
2. 加入构建前兼容检查并验证错误分支。
3. 运行 test、TypeScript 7 typecheck、weapp build。
4. 清理开发者工具缓存后导入新 `dist`,用稳定基础库确认 app 与首页注册。
5. 回滚时恢复原 lockfile/依赖即可;无数据或 API 迁移。
