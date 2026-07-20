// Receipt head — pure presentational. The 验货小票 merchant header (see
// apps/miniapp/DESIGN.md §4): a mono document-type eyebrow「单价验货单」, the
// centered「会员商店值不值」wordmark (值不值 in brand blue), and the tagline
// 「拆穿超市单价障眼法」, closed by a dashed ledger rule. No lens mark — the head
// stays centered and clean like a printed receipt header.
//
// The brand string is a single source of truth shared with navigationBarTitleText
// — exported here so the page/app config reference one constant.
import { View, Text } from '@tarojs/components';

import './BrandHead.css';

/** Single source of truth for the brand wordmark (= navigationBarTitleText). */
export const BRAND_NAME = '会员商店值不值';
/** The non-blue prefix and the blue-accented suffix of the wordmark. */
export const BRAND_PREFIX = '会员商店';
export const BRAND_ACCENT = '值不值';
export const BRAND_TAGLINE = '拆穿超市单价障眼法';
/** Receipt document-type eyebrow. */
export const BRAND_RECEIPT_LABEL = '单价验货单';

export default function BrandHead() {
  return (
    <View className="brandhead">
      <Text className="brandhead__label">{BRAND_RECEIPT_LABEL}</Text>
      <Text className="brandhead__wm">
        <Text className="brandhead__wm-prefix">{BRAND_PREFIX}</Text>
        <Text className="brandhead__wm-accent">{BRAND_ACCENT}</Text>
      </Text>
      <Text className="brandhead__tag">{BRAND_TAGLINE}</Text>
    </View>
  );
}
