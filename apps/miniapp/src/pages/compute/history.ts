// On-device local 比价历史 — a tiny ring buffer in Taro local storage, NO network
// and NO on-device price math. The 我的 Tab reads it; the 比价 page writes it after a
// successful POST /compute and reads it back for backfill. Two pages stay decoupled
// through this single storage key — neither imports the other's state.
//
// Boundary: the stored `input` REUSES `ComputeRequestSchema` from
// `@unit-price/api-client` (禁手写重复类型). All validation runs through that schema
// with `{ jitless: true }` — the WeChat mini-program forbids `eval`/`new Function`,
// so Zod's JIT fast-path crashes in weapp (same constraint as parseComputeResponse).
// We do NOT import `zod`/`z.object` into miniapp; the wrapper-field checks
// (`summary`, `ts`) are plain typeof/Number.isSafeInteger guards.
import Taro from '@tarojs/taro';
import { ComputeRequestSchema, type ComputeRequest } from '@unit-price/api-client';

/** Storage key for the on-device 比价历史 ring buffer. */
export const HISTORY_KEY = 'compute:history';

/** Ring-buffer capacity — newest at index 0, oldest dropped past N. */
export const HISTORY_MAX = 20;

/**
 * One history entry: the structured compute `input` (reuses the api-client
 * schema), a display `summary` snapshot taken at write time, and a stable,
 * monotonically-unique `ts` used both as the backfill handle and the list key.
 */
export interface HistoryItem {
  input: ComputeRequest;
  summary: string;
  ts: number;
}

/**
 * Mirror of the server's `meetsComputeRequiredSet` presence check (which lives in
 * `packages/core` and acts on `ParsedSpec` — core is NOT imported on-device, so
 * this is a hand-written mirror, kept同口径 with the server required set).
 *
 * `ComputeRequestSchema` only forbids "both unitSize AND totalAmount" and makes
 * `quantity` optional — it does NOT forbid "neither", so a degenerate item (no
 * amount field at all, OR a `unitSize` without `quantity`) can pass the schema yet
 * NOT be a complete input. Such an item would backfill into `unit=undefined` or
 * fabricate a `quantity`, so it is dropped at read time.
 */
function meetsRequiredSet(input: ComputeRequest): boolean {
  return (
    input.totalAmount != null ||
    (input.unitSize != null && input.quantity != null)
  );
}

/**
 * A read-time per-item normalizer: wrapper fields + schema + required set. On
 * success returns the NORMALIZED item (`input` = Zod's `parsed.data`, canonical
 * keys, unknown keys stripped) so later dedup by `JSON.stringify(input)` is robust
 * regardless of stored key order; on any failure returns `null`.
 */
function normalizeItem(raw: unknown): HistoryItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as { summary?: unknown; ts?: unknown; input?: unknown };
  // Wrapper fields — plain guards (no zod). `Number.isSafeInteger` rejects
  // 0/negative/decimal/NaN/Infinity and out-of-safe-range tampered values, and we
  // also reserve `MAX_SAFE_INTEGER` (the write-time cap sentinel) so a tampered
  // entry at the cap can't pin `prevMaxTs` and degrade the ring to one entry — a
  // surviving `ts` is always a legal positive integer usable as handle/React key.
  if (typeof item.summary !== 'string') return null;
  const ts = item.ts;
  if (!Number.isSafeInteger(ts) || (ts as number) <= 0 || (ts as number) >= Number.MAX_SAFE_INTEGER) {
    return null;
  }
  // input — reuse the api-client schema; jitless is the weapp hard constraint.
  const parsed = ComputeRequestSchema.safeParse(item.input, { jitless: true });
  if (!parsed.success) return null;
  // Complete required set (server-mirrored presence): drop degenerate items.
  if (!meetsRequiredSet(parsed.data)) return null;
  return { input: parsed.data, summary: item.summary, ts: ts as number };
}

/**
 * Read the on-device history, returning only well-formed, deduped entries.
 *
 * Robustness: ① guard the container with `Array.isArray` first (a corrupt /
 * never-written value → `[]`, never `.map` on a non-array); ② validate每项 —
 * wrapper fields, `ComputeRequestSchema.safeParse(..., { jitless: true })`, and
 * the complete required set — silently dropping缺字段 / 类型损坏 / 旧 schema 残留 /
 * 退化项; ③ dedupe by `ts` (keep the FIRST occurrence of each `ts`) so a tampered
 * store with duplicate `ts` can't make `find`/React keys ambiguous.
 */
export function readHistory(): HistoryItem[] {
  let raw: unknown;
  try {
    raw = Taro.getStorageSync(HISTORY_KEY);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const out: HistoryItem[] = [];
  for (const candidate of raw) {
    const item = normalizeItem(candidate);
    if (!item) continue;
    if (seen.has(item.ts)) continue; // dedupe ts — keep first
    seen.add(item.ts);
    out.push(item);
  }
  return out;
}

/**
 * Write one entry after a successful compute.
 *
 * - normalize the incoming `input` through `ComputeRequestSchema` first so the
 *   STORED item is canonical (schema key order, unknown keys stripped) — same
 *   shape `readHistory` returns. Without this, the caller's `buildComputeRequest`
 *   order (`{totalPrice, category, …}`) differs from the read-normalized order
 *   (`{totalPrice, quantity, unitSize, totalAmount, category}`), and the
 *   order-sensitive `JSON.stringify` dedupe below would never match a re-stored
 *   item → a recompute would stack instead of moving to front.
 * - `base` = current clean history (`readHistory`).
 * - `prevMaxTs` is taken BEFORE dedupe (full-set max) — taking it after dedupe
 *   would lose monotonicity exactly when the dropped item is the newest one.
 * - dedupe: drop the old item whose `input` deep-equals (JSON.stringify of the
 *   canonical form) the new one — a "recompute" is treated as moving it to front.
 * - `ts = Math.min(MAX_SAFE_INTEGER, Math.max(Date.now(), prevMaxTs + 1))`:
 *   monotonically unique (two different inputs in the same millisecond never
 *   collide) and capped so a tampered `MAX_SAFE_INTEGER` entry can't push the new
 *   `ts` out of the safe-integer range.
 * - `[new, ...rest].slice(0, HISTORY_MAX)`: newest at index 0, oldest dropped (切尾).
 * - `setStorageSync` wrapped in try/catch — a write failure (quota full /
 *   storage unavailable) only loses this one history entry; it never blocks the
 *   compute result display.
 */
export function appendHistory(input: ComputeRequest, summary: string): void {
  // Canonicalize the incoming input so stored items match read-normalized ones
  // and the JSON.stringify dedupe is key-order-stable. built.request is always
  // valid, so a parse failure here is defensive — skip the write rather than
  // store a non-canonical / invalid entry.
  const parsed = ComputeRequestSchema.safeParse(input, { jitless: true });
  if (!parsed.success) return;
  const normInput = parsed.data;
  const base = readHistory();
  const prevMaxTs = Math.max(0, ...base.map((h) => h.ts));
  const key = JSON.stringify(normInput);
  const rest = base.filter((h) => JSON.stringify(h.input) !== key);
  const ts = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(Date.now(), prevMaxTs + 1),
  );
  const next: HistoryItem[] = [{ input: normInput, summary, ts }, ...rest].slice(
    0,
    HISTORY_MAX,
  );
  try {
    Taro.setStorageSync(HISTORY_KEY, next);
  } catch {
    // 写失败仅丢历史、不阻断结果展示。
  }
}

/** Format a `{ value, unit }` measurement for the summary. */
function fmtMeasure(m: { value: number; unit: string }): string {
  return `${m.value}${m.unit}`;
}

/**
 * A readable one-line summary snapshot for the 我的 list. Includes the category
 * DISPLAY name (`cohortName` — `input.category` is only a slug, passed in by the
 * caller). Pure string; takes no Taro/IO.
 */
export function summarizeInput(
  input: ComputeRequest,
  cohortName: string,
): string {
  const amount =
    input.unitSize != null
      ? `${fmtMeasure(input.unitSize)}×${input.quantity ?? 1}`
      : input.totalAmount != null
        ? fmtMeasure(input.totalAmount)
        : '';
  const parts = [cohortName, `¥${input.totalPrice}`, amount].filter(Boolean);
  return parts.join(' · ');
}

/**
 * Find a history entry by its stable `ts` handle (for backfill). Reads through
 * the same validating `readHistory`, so a stale/invalid handle simply misses.
 */
export function findHistoryByTs(ts: number): HistoryItem | undefined {
  return readHistory().find((h) => h.ts === ts);
}
