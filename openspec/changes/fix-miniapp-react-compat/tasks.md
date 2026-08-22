## 1. 依赖兼容(`apps/miniapp`)

- [x] 1.1 将 `react` / `react-dom` 固定为 18.3.1、`@types/react` 固定为 18.3.31并更新 `pnpm-lock.yaml`;frozen install 与 `pnpm why` 验证无 React 19且 Taro/reconciler peer 满足
- [x] 1.2 Dependabot 已忽略 `react` / `react-dom` / `@types/react` semver-major;YAML 与三条规则验证通过,React 18 minor/patch 分组保持不变

## 2. 构建前守卫(`apps/miniapp/scripts`)

- [x] 2.1 实现零依赖 React/Taro 兼容检查,5 条脚本测试覆盖兼容、实际安装树、React major 不匹配、react-dom 漂移及无法解析 peer
- [x] 2.2 同一检查已置于 `build:weapp` 与 `dev:weapp` 首位;不兼容 fixture 非零退出且错误含实际版本与 peer 范围

## 3. 自动验证与构建

- [x] 3.1 miniapp 118 个测试、TypeScript 7 typecheck 与 `build:weapp` 全部通过,已重新生成 `apps/miniapp/dist`
- [x] 3.2 最终依赖树/lockfile/bundle 无 React 19且包含 React 18.3.1;workspace build 与 783 个测试全部通过

## 4. 微信运行时验收

- [x] 4.1 已清理微信开发者工具缓存并以稳定基础库导入新 `dist`;确认无 `ReactCurrentBatchConfig` / `app.js` 启动异常,App 与 `pages/index/index` 正常注册
