# 派生数据回填与修正 运维 Runbook

## 目的

对**生产存量商品**跑派生数据的回填与修正:①打标签 backfill(经打标签管线产出品类归属、重算 `rankable`、补 `category_closure` 命中);②native-id 回填(给存量行补 `product_raw.native_category_id`);③单价偏差修正(重灌 + 逐行检测器,把冻结在旧价上的 `unit_price` 派生值追平)。三者的入口、机制与产物都不同,见下节。

## 三类回填与修正(勿混)

1. **打标签 backfill(`runBackfill` / `POST /admin/backfill`)= 重读列再打标签**。它**不写 `product_raw`**:只**读**既有 `product_raw`(title + store + `native_category_id`)经打标签管线**重新计算**品类归属,写 `product_tag` / `pending_category_tag_id` / `rankable` / `category_closure`。幂等、可重复驱动(本文「驱动」节)。native-id 接通后,`native_category_id` 非空的行经此入口由 store-map 重分类。**不重放 `/ingest`**——理由是 `/ingest` / `upsertRaw` **会把 title/price/`captured_at` 覆写为重放观测并触发后台 tier2 解析**;**不是**「写不进去」:去重命中时 `unit_price` 的派生值现在会随重报刷新,旧的 first-write-wins 理由链已不成立。

2. **native-id 回填 = 单独的 native-id-only `UPDATE` 步骤**(不经 admin 端点)。存量 ~376 行当初仅采标题/价格、`native_category_id` 为 null;经山姆 HAR 提取器抽每条 `(store, storeSku, categoryIdList 叶 id)`,产出幂等 SQL,用 `wrangler d1 execute` 对既有行做 **`UPDATE product_raw SET native_category_id = COALESCE(...)`**——**只补 `native_category_id` 一列、不碰 title/price、不触发解析、不新增 admin 路由、不重放 `/ingest`**(理由同 ①;见下「native-id-only UPDATE 回填」节)。

3. **单价偏差修正 = 重灌 + 检测器**(见「单价偏差修正」节)。它**不是一个端点,是一个循环**:重抽 HAR 重灌 → 跑检测 SQL → 对**可修**的偏差行点名经同步 `/contribute` 重报 → 再检测,直到可修集为空。与 ① ② 相反,它**正是靠重报观测推进的**:`upsertRaw` 推进 `product_raw` 的 title/price/`captured_at`,同一次调用的 `saveParsed` 把 `unit_price` 的派生五列刷到本次解析结果。

**先后顺序**:先做 ② native-id 回填(把 native 列灌进存量),再做 ① 打标签 backfill(让 store-map 在已落 native-id 的行上点火重分类)。③ 的每一轮循环内同样是先重灌、再跑 ① 打标签 backfill(重灌中标题漂移产生的新 `product` 行默认 `rankable=0`,这一步把它们拉进榜)、最后跑检测。

## 前置

1. **代码已合并 main 并自动部署**:GH Actions 在 push 到 main 时自动 migrate + deploy prod。
2. **设两个独立 secret**(不写进仓库 / 不写进 `wrangler.toml`)。两值都用**强随机**(低熵 key 可被离线爆破),且**互不相同**:

   生产 Worker 是 `wrangler.toml` 的 `[env.production]` 环境,故 `wrangler secret put` **必须带 `--env production`**——否则会设到顶层 dev(`unit-price-dev`)、prod 仍未配。从 `apps/api/` 跑(wrangler 在 cwd 找 `wrangler.toml`):

   ```sh
   cd apps/api

   # admin 端点鉴权凭据(逗号分隔多 key);与公共 API_KEYS 分离。
   openssl rand -hex 32                       # 生成强随机值,记下来(驱动时作 Bearer token)
   npx wrangler secret put ADMIN_API_KEYS --env production         # 粘上面的值

   # 审计日志 keyed 哈希的 keying 输入;必须与 ADMIN_API_KEYS【不同源】。
   openssl rand -hex 32                       # 另生成一个不同的强随机值
   npx wrangler secret put AUDIT_LOG_HMAC_SECRET --env production  # 粘这个值
   ```

   wrangler 需先 `wrangler login`(或设 `CLOUDFLARE_API_TOKEN`)。**替代:** Cloudflare 控制台 → Workers & Pages → `unit-price-api`(production)→ Settings → Variables and Secrets → 加两个加密 secret(免本地登录)。

   - `ADMIN_API_KEYS` 未配 / 空 → admin 端点 fail-closed 返回 `500 config-error`、不驱动 backfill。
   - `AUDIT_LOG_HMAC_SECRET` 未配 / 空 → 同样 fail-closed `500 config-error`(审计 keying 必需、不以弱常量盐降级运行)。**两个都设好前端点都会 500,这是设计、非故障。**

## 驱动

以脚本循环 `POST https://<api-域>/admin/backfill` 带 `Authorization: Bearer <admin-key>`:

- `limit` **省略即可**(服务端注入默认有界 limit、恒走 keyset 分块)。
- 每次响应取 `nextCursor`,作下次 `?cursor=<nextCursor>` 入参;首次不带 `cursor`。
- 循环直到 `nextCursor` 为 `null`。

示例 shell 循环(curl + jq)。**zsh 注意**:`KEY`/`API` 用**单引号**赋值——双引号下 key/URL 里的 `!` 会触发 zsh 历史展开报 `zsh: event not found`;`set +H` 再加一道保险(或直接把本段存成文件用 `bash 文件` 跑,脚本文件不做历史展开):

```sh
set +H                              # 关闭 zsh ! 历史展开(双保险)
API='https://<api-域>'              # 单引号:URL 含 ! 也安全
KEY='<admin-key>'                   # 单引号:key 含 ! 也安全
cursor=''

while :; do
  if [ -z "$cursor" ]; then
    url="$API/admin/backfill"
  else
    url="$API/admin/backfill?cursor=$cursor"
  fi

  resp=$(curl -sS -X POST "$url" -H "Authorization: Bearer $KEY")
  echo "$resp"

  cursor=$(echo "$resp" | jq -r '.nextCursor')
  if [ "$cursor" = 'null' ]; then
    echo 'backfill 完成:nextCursor=null'
    break
  fi
done
```

## 完成判据(机械)

- 游标**单调推进**到 `nextCursor=null`。
- 累计处理覆盖 bootstrap 起始快照存量的**每个 product id 至少一次**。
- 续跑期间并发 `/ingest` 新落的行落入**下一轮 sweep**、不计入本轮分母。
- **注**:存量恰为 `limit` 整数倍时,末尾会观测到一次 `total:0` 且 `nextCursor=null` 的空读——这是**正常终止信号、非错误**。

## 响应字段

```json
{ "total": …, "classified": …, "pending": …, "manual": …, "rankable": …, "storeMapDecisions": …, "nextCursor": … }
```

只回计数 + `nextCursor`,**不含逐商品明细**(`nextCursor` 为 `null` 表示已耗尽)。

- `storeMapDecisions`:本块内由 **store-map 定叶**(`decidedBy=store-map` — store-map 叶**异于** tier1 叶,或 tier1-miss 由 store-map 叶兜住)的决定数。按设计**不含**同叶认同(记 tier1)与粗 native(落 pending),故 `>0` 即证 store-map 在主动定叶。**backfill 分块续跑,门值须跨所有块累加**——单块响应非全量;判 6.3「store-map 决定数 > 0」门时把各块 `storeMapDecisions` 相加。

## 归档前(运维项)

- 确认**首轮 backfill 已实跑**并达成上面的覆盖判据(游标推进到 `nextCursor=null` 且覆盖每个快照 id ≥ 一次)。
- **记录** backfill 前后 `manual`(待人工)绝对计数作**观测项**——非门:tier1 对某批恰好全不命中时 `manual` 可能持平而逻辑仍正确,门只是覆盖判据。

## native-id-only UPDATE 回填 + 重跑 backfill + 精度抽样

存量行的 native-id 接通流程(上面「三类回填与修正」的 ②→① 串联 + 验收),全程**不重放 `/ingest`**:

### ① 先验 join-rate(必做,非默认成立)

回填命中依赖 HAR 提取器抽的 `(store, storeSku)` 与既有 `product_raw` 行键一致;若不一致,`UPDATE` **0 命中**、本步收益落空。**批量 UPDATE 前**先做一次**只读** join-rate 校验(抽取键 ∩ 既有 `product_raw` 命中率)。命中率过低**先查 key 口径**(storeSku 应与当初 ingest 落库去重键同源)、**勿盲灌**。漏配行 `native_category_id` 留 null(退化 tier1、不回退、不损坏)。

### ② native-id-only `UPDATE` 回填

HAR 提取器抽存量每条 `(store, storeSku, categoryIdList 叶 id)`,产出**幂等 SQL 文件**,每行形如:

```sql
UPDATE product_raw SET native_category_id = COALESCE(native_category_id, '<nativeId>') WHERE store='<s>' AND store_sku='<sku>';
```

`COALESCE` **只补空**(保留已有 native_category_id[如前向 ingest 已写],仅填 null 行)。对 prod 执行:

```sh
wrangler d1 execute DB --env production --remote --config apps/api/wrangler.toml --file <生成.sql>
```

`--config` **必带**(否则从仓根解析不到 `DB` 绑定)。此步**只动 `native_category_id` 列、不碰 title/price、不触发解析、不新增 admin 路由、不走 `/ingest`**;`d1 execute` 不被部署守卫 `check-no-prod-drizzle-migrate.sh` 拦(它只拦 `drizzle-kit migrate`)。

### ③ 重跑打标签 backfill

native-id 已落后,按本文「驱动」节重跑 `POST /admin/backfill`(幂等):`native_category_id` 非空的行经 store-map 重分类,归属变化重算 `rankable`(既有契约)。读响应的 `storeMapDecisions`(**跨所有续跑块累加**)确认 store-map 在主动定叶(`>0`)。

### ④ store-map 精度抽样(必做)

仲裁反转后(native 叶 ≻ tier1 叶),一行错 map 会压过本来分对的 tier1 叶,blast radius 增大,故精度抽样是回填验收**必做项**、非可选。**离线判定**(`product_tag.source` 只存终态、反推不出 tier1 本会判什么):离线重放 `tagTier1Leaf(title)` + `lookupStoreCategory(store, nativeId)`,筛 `tier1.leaf != storeMap.leafSlug ∧ 两者皆非空`(= 被 store-map 改写的 tier1 叶)的样本 → **人工**核对其标题语义 / 山姆自身展示分类与 store-map 落叶是否一致。出现 tier1-对→store-map-错 = **blocker**:回滚该 `SAM_CATEGORY_MAP` 行后再宣告成功。(eval-harness 当前无 native 叶真值字段[corpus 只有 `samPkgNum`、无 `samCategoryLeafId`],本期门用人工抽样、不依赖尚不存在的自动评测。)

## 单价偏差修正(重灌 + 检测器)

去重命中时 `unit_price` 的派生五列(`per100ml` / `per100g` / `formula` / `confidence` / `warnings`)会被本次解析结果刷新,但**只对重报到的行生效**:在此之前落下的偏差行(`product_raw.price` 已前进、`unit_price` 仍按首报价算)要靠**重灌**追平。这不是一个端点,是一个**循环**。

### 存量口径(2026-07-27 普查快照)

| 项 | 实测 |
|---|---|
| `product` / `product_raw` / `rankable=1` | **1197 / 1297 / 507** |
| 偏差行(`unit_price` 派生值 ≠ `product_raw.price`) | **69**,其中 `rankable=1` **46**、可修 **69**、幽灵 **0** |
| 幽灵行(同一 `raw_id` 挂多条 `product`) | **4 组 8 条**(零偏差、`per100ml` 全 NULL 故零在榜) |
| `price ≤ 0` 的 raw | **26**(其中 **15** 落在偏差集合内) |
| `formula IS NULL` 且 `price > 0` | **227** |
| `per100ml IS NOT NULL`(榜单数据门) | **441** |

**偏差集合的成分**(决定收尾时该预期什么):`product_raw` 那一侧**几乎全是新价**——44/69 的 `captured_at` 是 **2026-07-21**,方向压倒性是**降价**(促销结束 / 调价),故重灌后榜单**排序会明显变动**;另有 **15** 条 `price = 0`(下架 / 缺货),它们一被刷新就 `per100ml` 写 NULL、**退出榜单**。

这些是**某次普查的快照、不是常量**:每轮修正**前**先跑一次检测取当轮基线,否则末尾的「变化」无从归因。(上文「三类回填」② 里的「存量 ~376 行」记的是 native-id 回填当时的口径,不随此表更新。)

### 窗口边界(必须先立)

**「检测干净」只有在没有在飞异步写的窗口内才是持久结论。** `/ingest` 与 `/ingest/batch` 是 `202` + 后台解析,系统**没有 drain 信号**:检测跑出零偏差的那一刻,可能还有在飞的后台单元随后把更旧的观测刷进 `unit_price`,而它**没有后继写者**来收拾。

**重灌本身走 `/ingest/batch`**,所以顺序是**先灌满、再关闸**,不能反过来:

1. **重灌与打标签 backfill 在入口开放时完成**——它们就是那批异步写;
2. 灌完后**暂停 `/ingest` 与 `/ingest/batch` 入口**,此后唯一写者是运维自己;
3. **排空只有经验判据,没有证明**:关闸后连跑两轮 census ②b,**逐行输出相同**即视为在飞单元已落定。这是**经验证据**——它只说明观察间隔内没有新写落地,**不**排除更长的延迟单元。判据不成立就等更久再连跑两轮,或按下条降级;
4. 点名重报**一律走同步 `/contribute`**(`upsertRaw → orchestrate → saveParsed` 全在请求内完成,写完即终态),**禁止**走 `/ingest`——那会重新引入在飞单元;
5. 最终检测在窗口内跑完,**之后**才开放入口。

第 3 步的经验判据不成立(或不愿等)时,完成判据**降级为「查询瞬间干净」**,并须明示本轮**不给**持久保证。

### 检测

唯一可跑形态是 `scripts/census-drift.sql`(只读、不写任何行):

```sh
wrangler d1 execute unit-price-prod --config apps/api/wrangler.toml --env production --remote --file scripts/census-drift.sql
```

census ② 的偏差谓词是「`formula` 首项(元)按分四舍五入 ≠ `product_raw.price`」,并把结果分成 `drifted_fixable_by_reingest`(可修)与 `drifted_ghost`(幽灵行,重报只会写新键、修不到旧行)。**核对按分相等、禁用浮点容差**——`|首项 − price/100| ≤ 0.01` 会把真正过期一分钱的行判绿。census **②b** 用同一谓词输出**可修偏差行的 `(store, store_sku)` 明细**,那是下面循环第 3 步要和 HAR 求交的清单。该谓词共三份(census ②、②b、`design.md` D3 摘录),**三处必须同改**。

**覆盖面必须记牢,否则判据会撒谎**:

- 谓词只覆盖 **`formula` 非空**的行;`formula IS NULL` 的行求值为 NULL、被 `WHERE` 丢弃,它们**不在覆盖内**、**不等于**「干净」,由 census ④b 单独计数。
- 检测器从 `unit_price` 起 join,故「有 product 无 `unit_price`」与「有 raw 无 product」(后台首插失败的中间态)**整类不可见**——这正是 census ④ 与「重灌 SKU − 落到 `product`」差集要作**并列门**的理由。
- 谓词依赖 `formula` 的 canonical 形态,当前其唯一写者是 `saveParsed`(值恒来自 `calculate`);**若将来出现第二个写者,该谓词必须同步加严**。

### 循环与完成判据

1. **重抽 HAR 重灌**(经 `/ingest/batch`,入口仍开放)——命中行的派生值随该次解析落地而刷新。
2. **跑打标签 backfill**(从**空 cursor** 起跑,见「驱动」节):ingest 三条路径都不打标签,重灌中标题漂移产生的新 `product` 行是 `rankable=0`、不入榜,而被弃的旧行仍带 tag 在榜——这一步把新行拉进榜。
3. **关闸并确认排空**:暂停 `/ingest` 与 `/ingest/batch`,按上节第 3 步连跑两轮 census ②b 确认逐行相同。
4. **跑 `scripts/census-drift.sql`**:取 census **②b** 输出的 `(store, store_sku)` 明细,与本轮 HAR 的 `(store, storeSku)` **求交**;交集外的行本轮无数据源可重报,直接登记残留。
5. **对交集里的 SKU 经同步 `/contribute` 逐个重报**,回第 4 步。

**完成判据 = 两个并列门,均须满足**:

- `drifted_fixable_by_reingest = 0`;
- census ④(`products_without_unit_price`)为 0,**且**「本轮重灌 SKU 集合 − 落到 `product` 的集合」差集为空。

判据**不是「检测结果为空集」**:`drifted_ghost` 修不到(幽灵行的 `dedupe_key` 永不再命中,重报只会写新行),它**逐轮记数、作已披露残留登记,不进终止条件**。

**census ④b(`formula IS NULL AND price > 0`)是人工复核清单、不是失败门**:它无法机械区分「过期的 NULL」(曾 ≤0 价落 NULL、重报正价后解析失败)与「合法不可计算」(正价但无轴 / 规格不一致),区分要按已存 spec 重算,系统不提供该能力。实测 **227 行**——**行数不构成任何一侧的证据**,要判断成分只能人工抽样看 spec;逐轮记数即可,不阻塞收尾。

### 会跟着变的东西(收尾时须逐项归因)

- **榜单行数会变**,两个成因:①实测 **26 条** `price ≤ 0` 的 raw 一被重报就因不可计算退出榜单(`per100ml` 写 NULL,而榜单数据门是 `per100ml IS NOT NULL`;其中至少 1 条在重报前还挂在榜上);②解析漂移产生的 `rankable=0` 新行,查 `SELECT COUNT(*) FROM product WHERE rankable = 0 AND raw_id IN (SELECT raw_id FROM product GROUP BY raw_id HAVING COUNT(*) > 1)`。
- **榜单顺序会变**:排序键就是 `per100ml`,把偏差改对即改序。
- **幽灵行普查必须在重灌之后重跑**:重灌会改变该集合(标题漂移会新增幽灵组),基线清单不能复用;census ③ 的明细清单在任何重算跑过之后无法重建,取到就存档。

**已披露残留**(当前口径):幽灵行 **4 组 8 条**,全为重量轴 / 零价商品、`per100ml` 均为 NULL、均不在榜;逐行明细以当轮 census ③ 输出为准。

### 这是运维侧核对,不是系统自动校验

`formula` 内嵌的元价与 `price` 列的整数分是**两套金额**,系统**各自独立留痕、不做跨表交叉校验**(见 `openspec/specs/persistence/spec.md` 的 `unit_price` 需求)——那条约束约束的是**系统**:写路径不读回、不比对、不因两者不一致而拒写。本节的检测是**人跑的只读普查**,与该约束不冲突,也**不**是可以指望系统自己发现偏差的理由。

**收尾**:先按下节刷新 CDN + 预热,**再**开放 ingest 入口。

## 数据更新后:刷新 CDN(长 TTL 的配套,必做)

公共读端点 `/rankings`、`/categories` 的 `Cache-Control` 是 **`public, max-age=86400`(1 天)**(`apps/api/src/routes.ts` 的 `PUBLIC_CACHE_CONTROL`)。长 TTL 是为了让国内访问命中阿里云 POP、绕开跨境回源——代价是**任何改了 prod 数据的操作(`/ingest` 新批次、临时优惠、本文的 backfill / native-id 回填)生效前,边缘还会按旧缓存服务,最多 1 天**。

数据变更后**主动刷新阿里云 CDN**让其立即生效(否则只能等 TTL 自然过期)。**两个端点 ObjectType 不同**(`/rankings` 有 `?limit/offset/category` 等 query 变体、`/categories` 无 query):

- `/rankings` 用**目录(Directory)**刷新,一刀覆盖全部 query 变体:
  `aliyun cdn RefreshObjectCaches --ObjectPath 'https://unit-price.herbert-dev.cn/rankings' --ObjectType Directory`
- `/categories` 用 **URL(File)**刷新该精确地址(它无 query,目录型反而刷不到这个精确文件):
  `aliyun cdn RefreshObjectCaches --ObjectPath 'https://unit-price.herbert-dev.cn/categories' --ObjectType File`
- 控制台等价:`/rankings` 选"目录"、`/categories` 选"URL"。

**刷新后预热(建议,且必须预热客户端真实请求的精确 URL)**:单次回源跨境要 ~3–7s(实测 TTFB,POP→海外 CF/D1),purge 后**第一个真实用户会吃满这一跳**。CDN **按完整 query 串分键**,所以**必须预热小程序逐字节实际发的 URL**——榜单落地 Tab 调 `useRankings()` **不带 category**、发的是 `/rankings?limit=20&offset=0`(**不是** `?category=soft-drink`),预热错键等于没热。用 `PushObjectCache`(或直接 `curl`)逐条预热:

- 落地榜:`https://unit-price.herbert-dev.cn/rankings?limit=20&offset=0`
- 各 category-scoped 榜(用户从品类树下钻会发的):`…/rankings?limit=20&offset=0&category=<slug>`(soft-drink/乳品/酒种各叶)。**发参顺序必须与 `buildRankingsUrl` 一致(`limit→offset→category`)**——CDN 按原始 query 串分键,顺序错即键错、等于没热
- 品类树:`https://unit-price.herbert-dev.cn/categories`

(`limit`/`offset` 必须与端上 `PAGE_SIZE=20`、首页 `offset=0` 一致;改了 `PAGE_SIZE` 这里同步改。)命中后 total 降到 ~50ms。

**遵循源站(部署/依赖前必复验)**:长 TTL 生效的前置是阿里云 CDN **遵循源站 `Cache-Control`**(不以自有 TTL 规则覆盖)。当前实测满足(无自定义 TTL 规则;二次请求 `X-Cache: HIT`),但这是**控制台活配置、仓库管不住**——任何人加一条自定义 TTL/忽略源站规则就会静默让 86400 失效。故**不是一次性"已确认无需配置"**:每次依赖长 TTL 前、以及改动该域名 CDN 配置后,`curl -D - 'https://unit-price.herbert-dev.cn/rankings?category=soft-drink'` 看二次请求 `X-Cache` 是否 `HIT` 且 `Cache-Control` 透传为 `max-age=86400`,不满足说明源站头被覆盖、需到控制台修。`no-store`(搜索 `?q=`、`/compute`)不受影响、永不被缓存。

## 安全注

- admin 端点走独立 `ADMIN_API_KEYS` 鉴权(与公共 `API_KEYS` 分离),**不纳入公共限频**(不消耗公共 60/60s 窗口、不写公共 `rl:` / `usage:` 槽)。
- 审计日志以 keyed 哈希(`HMAC-SHA256(key, AUDIT_LOG_HMAC_SECRET)` 定长截断)记 key,**不落原文**、无前缀子串。
