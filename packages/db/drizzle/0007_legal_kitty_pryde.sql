ALTER TABLE `product_raw` ADD `lowest_price` integer;--> statement-breakpoint
-- Backfill the low-water mark for existing positive-price rows to their current
-- price (存量无历史流水 → only initializable to the current price, not the true
-- historical low). Positive-only (`price > 0` excludes anomalous ≤0 rows, which
-- stay NULL); `lowest_price IS NULL` makes the backfill self-idempotent — a
-- mistaken replay is a no-op and never resets an already-accumulated real low
-- back to the current price.
UPDATE `product_raw` SET `lowest_price` = `price` WHERE `price` > 0 AND `lowest_price` IS NULL;