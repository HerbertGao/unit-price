// Pure route-param reading for the board, extracted so the name-decode branch is
// unit-testable without the Taro runtime (the page itself can't run under vitest).
export interface BoardParams {
  /** Cohort slug, or undefined for the un-scoped list (missing / blank route). */
  category: string | undefined;
  /** Display title for setNavigationBarTitle. */
  name: string;
}

// WeChat's onLoad(options) URL-decodes query values once, so an already-decoded
// CJK name would make a second decodeURIComponent throw on any literal `%`. We
// can't pin Taro 4.2's exact decode behavior from here, so decode-once-with-raw-
// fallback is correct whether Taro hands back a decoded or a raw value, and never
// crashes the title-set.
// ponytail: a URL round-trip can't tell a literal `%XX` from an encoded one —
// fine for the fixed CJK category taxonomy (no `%`/`+`); revisit if names gain them.
export function readBoardParams(p: { category?: string; name?: string }): BoardParams {
  const category = p.category || undefined;
  const raw = p.name;
  let name = '分类榜';
  if (raw) {
    try {
      name = decodeURIComponent(raw);
    } catch {
      name = raw;
    }
  }
  return { category, name };
}
