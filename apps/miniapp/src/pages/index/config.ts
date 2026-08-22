// Single configuration constant for the rankings data source.
//
// v1 connects DIRECTLY to the prod API (public, key-free). China-reachable, ICP-
// filed front: unit-price.herbert-dev.cn → Aliyun CDN (domestic) → Cloudflare
// custom domain unit-price.herbertgao.me → unit-price-api worker. Chosen over the
// raw *.workers.dev origin because that subdomain is SNI-blocked in mainland.
//
// In the WeChat devtools tick "不校验合法域名" to hit prod from the IDE; real-device
// preview / store release require registering this origin under "请求合法域名"
// (a release gate bound to AppID/备案, NOT a development gate).
//
// BASE must be a CLEAN http(s) origin (no path/query/fragment) — buildRankingsUrl
// fails fast otherwise.
export const BASE = "https://unit-price.herbert-dev.cn";

/**
 * True until BASE is filled with a real prod origin. The data layer checks this
 * BEFORE building a URL so an unfilled placeholder surfaces a clear "BASE 未配置"
 * error state (not a generic URL-parse failure) — and an unfilled placeholder can
 * never be mistaken for a real config. Fill BASE per the `[手动验证]` step (5.2)
 * before WeChat-devtools verification / store upload.
 */
export const BASE_IS_PLACEHOLDER = BASE.includes("<待填");

/** Rows revealed per local slice of the snapshot (reach-bottom reveals one more). */
export const PAGE_SIZE = 20;

/**
 * The cohort the 榜单 Tab lands on when the caller names none.
 *
 * Named, not derived. "The shallowest single-axis node" sounds derivable and is
 * not: `soft-drink` and `dairy` are both depth-1 children of `beverage` and both
 * `per_100ml`, so the tree has no unique answer and any tie-break is an arbitrary
 * rule the tree does not carry — slug order silently picks `dairy`.
 *
 * MUST agree with `ScopeBar`'s `SCOPE_TEXT`, which names this cohort in prose.
 * The label was always a constant; deriving only the slug is what let the two
 * disagree.
 */
export const LANDING_COHORT = "soft-drink";

/** Human label for the same landing cohort; ScopeBar imports this value. */
export const LANDING_SCOPE_TEXT = "山姆软饮真实单价榜 · 元/100ml";
