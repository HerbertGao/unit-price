## Why

微信小程序启动时在 `react-reconciler` 读取 `ReactCurrentBatchConfig` 处崩溃。当前 `react@19.2.8` 超出 `@tarojs/react@4.2.1` 与其 `react-reconciler@0.29.0` 明确声明的 React 18 peer 范围;普通 webpack 构建仍会成功,因此需要修复依赖并让同类错配在打包前失败。

## What Changes

- 将 miniapp 的 `react` / `react-dom` 固定到 Taro 4.2.1 支持的 React 18 版本,并同步 React 类型与 lockfile。
- 在 `build:weapp` / `dev:weapp` 前增加零依赖兼容检查:已安装 React major 必须满足 `@tarojs/react` 的 peer major,且 `react-dom` 必须与 React 同版本。
- 重新运行 miniapp test、TypeScript 7 typecheck、weapp bundle,并在微信开发者工具稳定基础库下确认 app 注册和首页启动。

## Capabilities

### Modified Capabilities

- `miniapp`:构建集成新增 React/Taro peer 兼容门,确保可成功加载 app.js 并注册首页。

## 非目标

- 不升级 Taro 或尝试在 Taro 4.2.1 上兼容 React 19。
- 不修改榜单、搜索、分类、即时比价等产品行为或 API 契约。
- 不把切换微信灰度基础库当作根因修复;基础库切换只用于排除工具环境差异。
- 不触及抓取、众包、数据库或 LLM,无新增合规敏感面。

## Impact

- **Workspace**:`apps/miniapp`、根 `pnpm-lock.yaml`。
- **运行时**:React 主版本回到 Taro 4.2.1 的受支持范围;无业务数据迁移。
- **发布**:需要重建 `apps/miniapp/dist` 并重新在微信开发者工具/真机验证。
