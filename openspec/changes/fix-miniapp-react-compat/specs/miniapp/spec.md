## 新增需求

### 需求:miniapp 构建必须使用 Taro 支持的 React 运行时

`apps/miniapp` 的 React 运行时必须满足所安装 `@tarojs/react` 声明的 peer 主版本,且 `react-dom` 必须与 React 使用相同版本。开发与生产微信包在进入 webpack/Taro 编译前必须执行同一兼容检查;不兼容时必须以非零退出并报告实际版本与支持范围,不得产出一个“编译成功但 app.js 启动崩溃”的包。

#### 场景:兼容版本通过构建并注册首页

- **当** React 满足 Taro peer 范围且 react-dom 与其同版本
- **那么** miniapp test、TypeScript typecheck 与 weapp bundle 必须通过
- **那么** 微信开发者工具加载 app.js 时不得出现 `ReactCurrentBatchConfig` 读取异常,应用与 `pages/index/index` 必须完成注册

#### 场景:不兼容 React 主版本在打包前失败

- **当** 已安装 React 主版本不满足 `@tarojs/react` 声明的 peer 主版本
- **那么** `build:weapp` 与 `dev:weapp` 必须在进入 webpack/Taro 编译前非零退出
- **那么** 错误信息必须同时指出 React 实际版本和 Taro 支持范围

#### 场景:React 与 react-dom 版本漂移在打包前失败

- **当** `react` 与 `react-dom` 的实际安装版本不一致
- **那么** 兼容检查必须非零退出并指出两者版本,不得继续生成微信包
