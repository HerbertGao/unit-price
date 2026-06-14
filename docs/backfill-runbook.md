# Taxonomy Backfill 运维 Runbook

## 目的

首次部署后,对**生产存量商品**跑 Taxonomy 打标签 backfill:经打标签管线产出品类归属(叶 `product_tag` / `pending_category_tag_id`)、重算 `rankable`、补 `category_closure` 命中。该入口为可重复驱动的受控运维端点,**不重放 `/ingest`**。

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
{ "total": …, "classified": …, "pending": …, "manual": …, "rankable": …, "nextCursor": … }
```

只回计数 + `nextCursor`,**不含逐商品明细**(`nextCursor` 为 `null` 表示已耗尽)。

## 归档前(运维项)

- 确认**首轮 backfill 已实跑**并达成上面的覆盖判据(游标推进到 `nextCursor=null` 且覆盖每个快照 id ≥ 一次)。
- **记录** backfill 前后 `manual`(待人工)绝对计数作**观测项**——非门:tier1 对某批恰好全不命中时 `manual` 可能持平而逻辑仍正确,门只是覆盖判据。

## 安全注

- admin 端点走独立 `ADMIN_API_KEYS` 鉴权(与公共 `API_KEYS` 分离),**不纳入公共限频**(不消耗公共 60/60s 窗口、不写公共 `rl:` / `usage:` 槽)。
- 审计日志以 keyed 哈希(`HMAC-SHA256(key, AUDIT_LOG_HMAC_SECRET)` 定长截断)记 key,**不落原文**、无前缀子串。
