# deployment 规范

## 目的

定义 API 在 Cloudflare Workers/D1 上的运行时、配置、迁移与持续部署边界，并约束国内 CDN 的长 TTL、刷新和预热流程，使公共读端点在可控陈旧范围内稳定命中国内边缘且可安全发布响应形状变更。

## 需求

### 需求:应用必须运行时无关并提供 Workers 入口

`apps/api` 必须把 Hono 应用拆为**运行时无关的 fetch 应用工厂**与**入口适配层**两部分。app 工厂产出标准 `fetch`-兼容应用，**禁止**在模块作用域或请求路径中直接依赖 Node-only API（含全局 `process.env`、`node:*` 内置、`@hono/node-server`）。生产入口必须是导出 `fetch(request, env, ctx)` 的 **Cloudflare Workers 模块**；本地 dev 入口（Node）必须复用**同一个** app 工厂，仅在入口层桥接运行时差异。两个入口产出的 `/health`、`/parse` 行为必须一致。

治理（鉴权/限频/用量）必须作为**可注入依赖**接入 app 工厂（与 LLM 端口同理），**禁止**在工厂内硬编码为必依赖 `GOVERNANCE_KV`/`API_KEYS` 的实现——使纯本地 dev（无 KV、无 allowlist）能注入一个**放行式 no-op 治理**，让 `/parse` 冒烟不被 `401`/`429` 阻断；生产入口注入真实治理实现。

**生产 Worker 入口必须注入真实治理，禁注 no-op（公网裸奔防线）**：放行式 no-op 治理一旦误注入生产入口（`worker.ts`），公网 API 即**完全无鉴权/无限频**，且 `/health` 与带/不带 key 的 `/parse` 冒烟**都会通过**、无法察觉。因此必须有一条**可机械断言的护栏**——`worker.ts` 不得引用 no-op 治理符号（grep/类型标记可查），并以 miniflare/workerd 对 `worker.ts` 入口级集成测试断言「缺 key→401、合法 key→放行、超限→429」，**禁止**把这条生产主路径只压在 [手动验证] 上。

#### 场景:同一应用工厂被两个入口复用
- **当** 检查 `apps/api` 的源码组织
- **那么** 必须存在一个不依赖 Node-only API 的 app 工厂，被 Workers 入口与本地 Node dev 入口分别引用；业务路由代码中**禁止**出现 `process.env`/`node:*`/`@hono/node-server` 的直接引用

#### 场景:本地 dev 注入 no-op 治理后 /parse 冒烟可通
- **当** 纯本地 dev（`pnpm --filter api dev` 或 `wrangler dev` 未绑 KV/未配 `API_KEYS`）注入放行式治理后，POST 一个干净标题
- **那么** `/parse` 必须正常返回单价，**禁止**因缺 `GOVERNANCE_KV`/`API_KEYS` 而被治理中间件打成 `401`/`429`/`5xx`

#### 场景:生产入口注真实治理且有护栏
- **当** 检查 `worker.ts`（生产入口）的治理装配 + 入口级集成测试
- **那么** `worker.ts` **禁止**引用放行式 no-op 治理符号；必须有 miniflare/workerd 集成测试断言生产入口下「缺 key→`401`、合法 key→放行、超限→`429`」，使「误注 no-op 致全放行」可被自动检出

#### 场景:Workers 入口导出 fetch handler
- **当** 部署目标为 Cloudflare Workers
- **那么** 入口模块必须默认导出含 `fetch(request, env, ctx)` 的对象，由 Workers 运行时调用，返回与本地 Node 入口一致的 `/health`、`/parse` 响应

### 需求:配置必须经注入的 env 而非全局 process.env

LLM 配置（`OPENROUTER_API_KEY` 等）必须**经显式传入的 env 对象**读取：Workers 路径下 env 来自 fetch handler 的 `env` binding，本地 dev 路径下由入口层从 `process.env` 取值后注入。**禁止**在 app 工厂或路由模块作用域读取全局 `process.env`。

**配置必须按请求从注入的 env 解析，且跨请求互不串台**：因 Workers 模块加载期没有 env，配置只能在请求期从 `c.env` 取——这是对 `parse-api` 推荐的「启动期 fail-fast」的**有意运行时偏离**（Workers 无模块期 env，无法在启动期读 key），但运行期行为契约不变。**默认每请求重建** LLM 端口（对象构造极廉价、零串台风险）；若实现选 isolate 内 memoize，**键必须覆盖完整 LLM config（`OPENROUTER_API_KEY` + model + baseURL）**，**禁止**「首个到达请求的 env 被固化、污染后续不同 env 的请求」，也**禁止**用过粗的键（如仅 model）导致不同 key 串台。

配置缺失语义必须遵循 `parse-api` 的**契约层**约束——缺 `OPENROUTER_API_KEY` 是**配置错误**，必须返回与「信息不足」**两层可区分**的 `5xx`（不同 HTTP 子码或不同 error code）。**实现层**沿用既有 `routes.ts` 的 `config-error`(HTTP `500`) 与 `insufficient-information`(HTTP `503`)（503/500 是当前实现取值、非 parse-api spec 钉死的契约，移植时保持不变即可）；干净标题（tier1 即可算）必须在无 key 时仍正常返回 `200`。

#### 场景:Workers env binding 注入配置
- **当** Worker fetch handler 收到请求，`env.OPENROUTER_API_KEY` 由 wrangler secret 提供
- **那么** 应用必须从该注入的 env 读取配置，**不得**触碰全局 `process.env`；请求进入 tier2 时使用该 key

#### 场景:不同 env 注入互不串台
- **当** 同一 isolate 内先后收到两个携带不同 LLM 配置 env 的请求（或 dev 与测试注入不同 env）
- **那么** 每个请求必须使用**各自**注入的 env 解析配置，**禁止**第一个请求的 env 被 memoize 后用于后续不同 env 的请求

#### 场景:缺 key 时干净标题仍可用
- **当** 生产/本地均未配置 `OPENROUTER_API_KEY`，客户端 POST 一个 tier1 即可算的干净标题（如 `可口可乐 330ml*24听`, price 40）
- **那么** 必须返回 `200` 与正确单价（不触发 tier2），**禁止**因缺 key 而对干净标题报错

#### 场景:缺 key 且需 tier2 时报可区分的配置错误
- **当** 未配置 `OPENROUTER_API_KEY`，且请求需要 tier2 补全（tier1 有 shape 但未独立满足计算必需集，或纯品名）
- **那么** 必须返回 HTTP `500` + error code `config-error`，与「信息不足」的 `503`/`insufficient-information` 在两层均可区分，不得伪装成 transport 失败

### 需求:wrangler 配置必须声明绑定与环境分层

`apps/api` 必须含 `wrangler.toml`，声明：生产 D1 数据库 binding（`DB`）、治理用的 KV namespace binding（`GOVERNANCE_KV`，承载限频计数 + 用量计数），以及 **production 与 preview 的环境分层**（各自独立的 D1/KV 资源 id）。`OPENROUTER_API_KEY` 与 `API_KEYS`（治理 allowlist）**禁止**写入 `wrangler.toml`，必须经 `wrangler secret put` 带外设为 runtime secret；`CLOUDFLARE_API_TOKEN`（部署凭据）经 CI Actions secret 注入。secret 必须 **production 与 preview 各配一份**——`OPENROUTER_API_KEY` 在 preview 同样需要配置，否则 preview 的 `/parse` 一旦触 tier2 行为未定义。`wrangler.toml` 引用的 binding 名必须与应用代码 `Bindings` 类型读取的名字（`DB` / `GOVERNANCE_KV`）一致。

#### 场景:绑定与代码一致且不含明文密钥
- **当** 检查 `apps/api/wrangler.toml`
- **那么** 必须声明 `DB`（D1）与 `GOVERNANCE_KV`（KV）binding，且 production/preview 分别指向不同资源 id；文件中**禁止**出现任何 API key / token / `OPENROUTER_API_KEY` / `API_KEYS` 明文；声明的 binding 名与应用代码读取的名字一一对应

#### 场景:preview 与 production 各配齐 secret
- **当** 配置 preview 与 production 两套环境
- **那么** `OPENROUTER_API_KEY` 与 `API_KEYS` 必须**各环境各配一份**（指向各自资源），**禁止**只配 production 而让 preview 的 tier2 / 鉴权处于未定义态

### 需求:生产 D1 迁移必须可复现执行

`packages/db` 已有的迁移必须能通过 `wrangler d1 migrations apply` 在生产与 preview D1 上执行，**幂等且可复现**（重复执行不重复建表/不报错）。

**迁移目录与幂等机制的接力契约（必须明确，避免与 `persistence` spec 冲突）**：drizzle-kit 在 `packages/db/drizzle/` 生成迁移 SQL，文件名形如 `0000_name.sql`（数字前缀与 wrangler 有序迁移命名兼容）。`wrangler.toml` 应把 `migrations_dir` 指向该 drizzle 输出目录、令 wrangler 直接应用同一批 SQL。**路径解析基准必须钉死**：wrangler 按 `wrangler.toml` 所在目录解析 `migrations_dir`（故值为 `../../packages/db/drizzle/`），且所有 `wrangler` 调用（本地与 CI）必须经 `--config apps/api/wrangler.toml` 或以 `apps/api/` 为工作目录执行——**禁止**依赖调用 cwd 偶然正确，否则「本地验过、CI 迁移找不到目录」。**但「wrangler 直吃 drizzle 输出目录」的完整兼容性是必须先验证的假设、不得当既成事实**：drizzle 输出含 `meta/` 子目录（`_journal.json`/快照）与 SQL 内 `--> statement-breakpoint` 标记（`--` 注释）。task 4.4 **[手动验证]** 必须在依赖「直指」前确认 `wrangler d1 migrations apply --local` 能容忍 `meta/` 子目录、原样接受 `statement-breakpoint` 注释；**若不兼容，fallback** = 部署流程加一步**脚本化**从 drizzle 输出 derive 一个 wrangler 兼容目录（剥 `meta/`、规整语句），该脚本必须防漂移（CI 校验派生目录与 drizzle 输出同源），而非手维护副本。

**生产/preview 幂等由 wrangler 自有的 `d1_migrations` 跟踪表保证**（wrangler 是生产 D1 的**唯一**迁移执行器）。这与 `persistence` spec 钉死的「幂等由 drizzle journal `__drizzle_migrations`」**不冲突且互不感知**——后者只治理**本地** `drizzle-kit migrate`（本地 SQLite 文件），生产 D1 上 drizzle journal **从不存在**。**关键风险**：因 drizzle 生成裸 `CREATE TABLE`（无 `IF NOT EXISTS`，见 `persistence`），一旦有人对生产 D1 误跑 `drizzle-kit migrate`，drizzle 因查无自己的 journal 会从 `0000` 重放、撞「table already exists」。故必须**机制性**禁止——不止文档禁令，CI/脚本须有 guard 确认无 `drizzle-kit migrate` 指向生产 binding。迁移一律走 wrangler 对 D1 binding 执行，作为部署流程**显式步骤**，非应用启动时隐式建表。

**preview 环境迁移生命周期**：preview D1 的迁移必须在 **PR 的 preview 部署步骤**中执行（preview 部署前 `wrangler d1 migrations apply` 对 preview binding），不得只靠一次性手动迁移——否则 preview 部署了读新列的 Worker 而 preview D1 未迁移会 schema 漂移。

#### 场景:迁移经 wrangler 幂等执行
- **当** 对一个已迁移过的 D1 再次运行 `wrangler d1 migrations apply`
- **那么** 必须无副作用地成功（wrangler `d1_migrations` 跟踪表标记已应用的迁移被跳过、不重放 `CREATE TABLE`），表结构与 `packages/db` schema 一致

#### 场景:wrangler 直吃 drizzle 输出经验证或走 fallback
- **当** 配置 `migrations_dir` 指向 `packages/db/drizzle/`
- **那么** 必须先 [手动验证] wrangler 能容忍 `meta/` 子目录与 `statement-breakpoint` 注释；验证通过则直指、**禁止**手维护漂移副本；验证不通过则启用脚本化 derive 的 fallback（带 CI 防漂移校验）

#### 场景:生产迁移不走 drizzle-kit 直连（机制性禁止）
- **当** 检查部署/迁移流程与 CI/脚本
- **那么** 生产/preview D1 的迁移必须通过 `wrangler d1 migrations apply` 对 binding 执行；必须有 guard 确认无 `drizzle-kit migrate` 指向生产/preview binding（防裸 `CREATE TABLE` 重放撞表）

#### 场景:迁移半完成态的恢复路径
- **当** 单次 `wrangler d1 migrations apply` 在多条 `CREATE TABLE` 中途失败（D1 DDL 非完整事务），留下半建 schema、wrangler 未标记该迁移已应用
- **那么** 因 SQL 是裸 `CREATE TABLE`，直接重跑会撞「table already exists」；恢复路径必须明确为**手动介入**（清理半建对象后重跑，或对该迁移做一次性修复），**禁止**假装重跑自动幂等掩盖此态——部署流程须在迁移步骤失败时显式失败并告警，不带病继续 deploy

#### 场景:回滚时已迁移 schema 对旧 Worker 向前兼容
- **当** 部署流程为「先 migrate、后 deploy」，迁移成功但 `wrangler deploy` 失败、回滚到上一个 Worker 版本（迁移**不**随回滚撤销）
- **那么** 已应用的迁移必须对旧 Worker 代码**向前兼容**（迁移为加表/加可空列等增量，旧代码不读新列即可正常运行），**禁止**让一次失败部署使生产 schema 与运行中的旧代码不兼容。注：向前兼容是对**未来**迁移的约束，其强制（禁 drop/rename 列）属后续 enforcement，本期唯一迁移 `0000`（建表）天然满足

### 需求:CI/CD 必须支持 push-to-deploy

`.github/workflows` 必须在 push 到 `main` 时自动部署到 Cloudflare Workers 生产环境：步骤含构建、对生产 D1 应用迁移、`wrangler deploy`。CI **只需** `CLOUDFLARE_API_TOKEN`（Actions secret）来执行 deploy 与迁移；`OPENROUTER_API_KEY`/`API_KEYS` 是 **Worker runtime secret、经 `wrangler secret put` 带外设置、不随每次 deploy 重注**，**禁止**在 CI 步骤里注入它们。Pull Request 上**禁止**部署生产，只跑构建/测试与 wrangler dry-run（或 preview 部署）。任一步骤失败必须使工作流失败（不得静默放过）。

#### 场景:main push 触发生产部署
- **当** 提交合入 `main`
- **那么** 工作流必须依次构建、应用生产 D1 迁移、`wrangler deploy`，仅 `CLOUDFLARE_API_TOKEN` 经 Actions secret 注入（runtime secret 带外、不在 CI），全程无明文

#### 场景:PR 不部署生产
- **当** 一个 Pull Request 触发 CI
- **那么** 必须运行构建/测试与 wrangler dry-run/preview，**禁止**对生产环境执行 `deploy` 或生产 D1 迁移

### 需求:公共读端点必须经长 TTL 边缘缓存并在数据变更后刷新

公共只读端点(`GET /rankings` 全量快照、`GET /categories`)必须经长 TTL 边缘缓存,使国内访问命中阿里云 CDN POP、绕开跨境回源(实测 MISS 数秒、HIT ~50ms),代价是受控陈旧。各条必须满足:

- 成功响应带 `public` 且 TTL ≥ 1 天的 `Cache-Control`(经 `PUBLIC_CACHE_CONTROL`)。`/rankings` 沿用同一常量,不为「现在只有一个键」另设 TTL——第二套 TTL 口径会让本需求与预热需求的间隔约束各自为政。
- 边缘 CDN 必须遵循源站 `Cache-Control`,不得以自有默认 TTL 覆盖。
- **缓存键收敛必须由边缘的 query-string 归一化配置保证**,不能靠源站。已实测阿里云 CDN 默认把 query string 计入缓存键,故源站忽略参数只能保证响应体一致,拦不住 `?category=beer` 落成独立对象。本变更必须包含该配置动作,并 wildcard-purge 历史遗留的带参对象。
- 任何**改变 prod 数据**的运维(`/ingest`、临时优惠、打标签 backfill、native-id 回填)完成后必须 purge 并预热受影响路径。榜单侧受影响路径由「landing + 每个 cohort 的字面 slug 键」收敛为一条 `/rankings`。
- 未主动刷新时,边缘陈旧不超过 TTL,过期后自愈。
- `/compute` 的 `no-store` 不受本需求影响。`/rankings` 不再有 `?q=` 搜索响应,原「搜索响应不受本需求影响」一条随之失效。

#### 场景:非搜索公共读响应带长 TTL public 缓存头

- **当** `GET /rankings` 或 `GET /categories` 返回 `200`
- **那么** 带 `public` 且 `max-age ≥ 86400` 的 `Cache-Control`;`400/500` 路径不得带缓存头
- **当** 请求带任何被忽略的参数
- **那么** 源站响应体与缓存头与无参请求逐字相同(源站可执行、可断言的部分)
- **那么** 「只有一个缓存对象」由边缘归一化配置保证,并必须被验证:从国内视角对 `/rankings` 与 `/rankings?category=beer` 各取一次,二者必须指向同一边缘对象;不得仅以控制台配置项存在为凭

#### 场景:边缘遵循源站、TTL 内二次请求命中

- **当** 同一公共读 URL 在 TTL 内被二次请求
- **那么** 边缘从缓存命中返回、不回源

#### 场景:数据变更后刷新+预热使变更即时可见

- **当** 一次改变 prod 数据的运维完成
- **那么** 必须刷新并预热 `/rankings` 与 `/categories` 两条路径;榜单侧不再逐 cohort slug 刷键
- **当** 一次**改变响应形状**的部署完成
- **那么** 必须立即 purge(`RefreshObjectCaches`)再预热(`PushObjectCache`)所有改形公共读端点;本变更为 `/rankings` 与 `/categories`。必须从国内视角确认两者命中对象均为新形状,之后才发布依赖该形状的客户端;回滚同样必须先 purge——回滚会把旧形状响应重新灌进边缘,再滚回来也不自愈。「数据变更后刷新」不覆盖本情形:代码部署不是数据变更

### 需求:公共读边缘缓存应由定时预热尽量保持热(best-effort,缩小而非消除冷窗口)

公共读端点的国内边缘缓存应由周期性主动预热任务尽量保持热,以**缩小**而非消除 TTL 到期 / POP 驱逐后首个真实用户吃冷 MISS(实测 ~5–7s)的窗口。这是 best-effort,不得写成「永不冷」的保证:预热把冷窗口上界**在调度成功时**压到约等于预热间隔,cron 被跳过或延迟则更长。

- **灌入机制**:该域名 domestic scope,预热必须用阿里云 `PushObjectCache`;不得用海外 `curl`(热不到国内 POP)。
- **清除机制**:purge 与预热是**两个不同接口**,不可互相替代——`PushObjectCache` 只把当前源站响应灌进 POP,不会让已有对象失效。purge 必须用阿里云 `RefreshObjectCaches`;wildcard/前缀清除用 `ObjectType=Directory` 并以 `/` 结尾的 `ObjectPath`,单对象用 `ObjectType=File`。**顺序不可颠倒**:先 refresh 再 push,反过来会把刚灌的新对象立刻刷掉。
- **预热目标 = `/rankings` + `/categories` 两条**。`/rankings` 无参后,原「landing + 每个 rankable cohort 的字面 slug 键」枚举必须删除,连同 `PAGE_SIZE` 与 15 个 slug 清单及其手工同步注释。该清单是持续的漏项面,本变更消灭它而非换一份新的。不得保留任何 `?category=` / `?limit=` / `?offset=` 形态的预热 URL——它们已不构成独立缓存键。
- **实测确认(go/no-go)**:`PushObjectCache` 的 `ObjectPath` 形态在官方文档未明确,必须先实测确认预热后从国内视角 `X-Cache: HIT`(且非探测 `curl` 自造)。因预热 URL 已不含 query,原「query 串是否被当作预热缓存键」的实测项随之失效。
- **实测确认(go/no-go)**:`RefreshObjectCaches` 的 `ObjectType=Directory` 对 `/rankings` 这类**非目录路径**是否覆盖其全部带参变体,官方文档同样未明确。必须先实测:构造一个 `?category=beer` 的热对象 → refresh → 确认它变冷。若不覆盖,必须以 `ObjectType=File` 逐条刷新下列 16 个已知历史 rankings 路径,不得依赖已从 workflow 删除的运行时清单:
  - `/rankings?limit=20&offset=0`
  - `/rankings?limit=20&offset=0&category=soft-drink`
  - `/rankings?limit=20&offset=0&category=carbonated`
  - `/rankings?limit=20&offset=0&category=juice-plant`
  - `/rankings?limit=20&offset=0&category=coffee-tea`
  - `/rankings?limit=20&offset=0&category=drinking-water`
  - `/rankings?limit=20&offset=0&category=dairy`
  - `/rankings?limit=20&offset=0&category=milk`
  - `/rankings?limit=20&offset=0&category=yogurt`
  - `/rankings?limit=20&offset=0&category=lactic-drink`
  - `/rankings?limit=20&offset=0&category=baijiu`
  - `/rankings?limit=20&offset=0&category=wine`
  - `/rankings?limit=20&offset=0&category=spirits`
  - `/rankings?limit=20&offset=0&category=whisky`
  - `/rankings?limit=20&offset=0&category=beer`
  - `/rankings?limit=20&offset=0&category=sake-fruit-wine`。
- **频率 ≤ 边缘 TTL,且充分性经实测**:间隔必须 ≤ TTL(当前 1 天)。「预热是否刷新仍新鲜对象的 TTL」官方未文档化,必须实测判定是 (a) 只补已过期/驱逐对象,还是 (b) 总是回源并重置 TTL;不得在实测前断言 (b)。
- **凭据最小权限 + 失败隔离 + 每 URL 独立 + 全失败可见**:周期性预热任务的 RAM 子账号仅授 `cdn:PushObjectCache`。**形状变更部署所需的 purge 是另一件事**:它需要 `cdn:RefreshObjectCaches`,由**人工执行的发布凭据**承担,不得并进那个周期性任务的 AK——把刷新权授给一个每 12 小时自动跑的 job,意味着任何一次该 job 的缺陷都能清空线上缓存。两者都必须密文注入、不入库;单 URL 失败不影响线上、逐 URL 独立尝试并记 task id;**全部 URL 失败时任务必须以非零退出可见**,不得吞错致 job 静默变绿。URL 数由 17 收敛到 2 后该要求不得放松:两条同时失败意味着首屏与分类树一起冷。
- **存活可核对**:GH `schedule` 在仓库 60 天无活动后会被自动停用且漏跑不告警,必须有**命名周期**的人工核对或成功心跳,不得把「仓库活跃」当存活保证。

#### 场景:定时预热缩小(而非消除)冷窗口

- **当** 周期性预热任务触发并对各热 URL 调 `PushObjectCache`
- **那么** 冷 MISS 窗口在调度成功时 ≈ ≤ 预热间隔;不得断言「首个用户永不吃冷 MISS」——cron 可被跳过、LRU 驱逐亦可发生

#### 场景:domestic scope 下只认 PushObjectCache

- **当** 选择把内容灌进国内 POP 的机制
- **那么** 必须用 `PushObjectCache`,不得用海外 `curl`

#### 场景:预热目标覆盖全部 rankable cohort 的字面 slug 键

- **当** 编排预热 URL 清单
- **那么** `?category=<slug>` 形态的键已不存在,清单必须恰为 `/rankings` + `/categories` 两条;不得保留任何 cohort slug 枚举或 `PAGE_SIZE` 常量
- **那么** 原要求所防的漏项风险由**消灭清单**解决,不得以任何形式重新引入按 cohort 枚举的预热 URL

#### 场景:上线前实测两项未文档化行为(go/no-go)

- **当** 准备依赖预热机制
- **那么** 必须先实测:① 预热后从国内视角确认 `X-Cache: HIT`;② 判定预热对仍新鲜对象是 no-op 还是重置 TTL,据此定频率;两项未过不得上线依赖
- **那么** 原第 ① 项中「精确 query 键命中」的部分随 query 一并失效

#### 场景:凭据最小权限、失败隔离、存活可核对

- **当** 预热任务运行(含单 URL 失败 / 全部失败 / 整体漏跑 / cron 被停用)
- **那么** 周期任务凭据仅 `cdn:PushObjectCache`,**不含** `cdn:RefreshObjectCaches`(后者属人工发布凭据);单 URL 失败不影响线上、逐 URL 独立尝试并记 task id;全部失败必须非零退出可见;必须有命名周期的人工核对或心跳
