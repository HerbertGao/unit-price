## 修改需求

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
