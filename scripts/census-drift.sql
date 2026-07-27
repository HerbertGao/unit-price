-- 只读普查:决定「只关闸」是否够,以及是否还需要一个存量重算端点。
-- 跑法:wrangler d1 execute unit-price-prod --config apps/api/wrangler.toml --env production --remote --file scripts/census-drift.sql
-- 不写任何行。

-- ① 总量 + 幽灵行(同一 raw 挂多条 product;标题变过 → dedupe_key 永不再命中)
SELECT
  (SELECT COUNT(*) FROM product)                                                          AS products,
  (SELECT COUNT(*) FROM product_raw)                                                      AS raws,
  (SELECT COUNT(*) FROM product WHERE rankable = 1)                                       AS rankable_products,
  (SELECT COUNT(*) FROM (SELECT raw_id FROM product GROUP BY raw_id HAVING COUNT(*) > 1)) AS ghost_raws,
  (SELECT COUNT(*) FROM product p
     WHERE p.raw_id IN (SELECT raw_id FROM product GROUP BY raw_id HAVING COUNT(*) > 1))  AS ghost_products;

-- ② 偏差行总量,以及其中有多少是幽灵行(= 重灌修不了、只有重算端点能碰的那一类)
WITH dup AS (SELECT raw_id FROM product GROUP BY raw_id HAVING COUNT(*) > 1),
     drift AS (
       SELECT p.id AS pid, p.raw_id AS rid, p.rankable AS rankable
       FROM unit_price up
       JOIN product     p ON p.id = up.product_id
       JOIN product_raw r ON r.id = p.raw_id
       WHERE up.formula IS NOT NULL
         AND CAST(ROUND(CAST(up.formula AS REAL) * 100) AS INTEGER) <> r.price
     )
SELECT
  (SELECT COUNT(*) FROM drift)                                                 AS drifted_total,
  (SELECT COUNT(*) FROM drift WHERE rankable = 1)                              AS drifted_rankable,
  (SELECT COUNT(*) FROM drift WHERE rid IN (SELECT raw_id FROM dup))           AS drifted_ghost,
  (SELECT COUNT(*) FROM drift WHERE rid NOT IN (SELECT raw_id FROM dup))       AS drifted_fixable_by_reingest;

-- ③ 幽灵行明细(若 ① 的 ghost_raws 非零才有意义;这份清单在任何重算跑过之后就无法重建)
SELECT p.raw_id, p.id AS product_id, p.rankable, up.per100ml, up.formula, r.price, r.title
FROM product p
JOIN product_raw r  ON r.id = p.raw_id
LEFT JOIN unit_price up ON up.product_id = p.id
WHERE p.raw_id IN (SELECT raw_id FROM product GROUP BY raw_id HAVING COUNT(*) > 1)
ORDER BY p.raw_id, p.id;

-- ④ 数据损坏面:有 product 无配对 unit_price(投影用 leftJoin 的理由)
SELECT COUNT(*) AS products_without_unit_price
FROM product p LEFT JOIN unit_price up ON up.product_id = p.id
WHERE up.id IS NULL;

-- ④b 过期的 NULL 派生值(人工复核清单,不是失败门):派生说不可算、raw 说可算。
--     无法机械区分「过期」与「合法不可计算(无轴/规格不一致)」——区分需按已存 spec 重算。
SELECT COUNT(*) AS null_formula_with_positive_price
FROM unit_price up
JOIN product     p ON p.id = up.product_id
JOIN product_raw r ON r.id = p.raw_id
WHERE up.formula IS NULL AND r.price > 0;

-- ⑤ 置灰面(用户报的症状,全库口径;榜单口径已测得 330/361)
SELECT
  COUNT(*)                                                                                AS raws_total,
  SUM(CASE WHEN captured_at < (strftime('%s','now') - 30*86400) * 1000 THEN 1 ELSE 0 END) AS raws_stale_30d
FROM product_raw;
