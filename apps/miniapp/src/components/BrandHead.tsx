// Brand head — pure presentational. Translates the P0 ".appbar"/".brand"/".lens"
// block: the `Sams值不值` wordmark (值不值 in brand blue), the tagline
// "拆穿超市单价障眼法", and the "价格透视镜" ¥ lens mark on the right.
//
// The brand string is a single source of truth shared with navigationBarTitleText
// — exported here so the page/app config reference one constant (the page wires
// it; this component renders it).
import { View, Text } from '@tarojs/components';

import './BrandHead.css';

/** Single source of truth for the brand wordmark (= navigationBarTitleText). */
export const BRAND_NAME = 'Sams值不值';
/** The non-blue prefix and the blue-accented suffix of the wordmark. */
export const BRAND_PREFIX = 'Sams';
export const BRAND_ACCENT = '值不值';
export const BRAND_TAGLINE = '拆穿超市单价障眼法';

export default function BrandHead() {
  return (
    <View className="brandhead">
      <View className="brandhead__brand">
        <Text className="brandhead__wm">
          <Text className="brandhead__wm-prefix">{BRAND_PREFIX}</Text>
          <Text className="brandhead__wm-accent">{BRAND_ACCENT}</Text>
        </Text>
        <Text className="brandhead__tag">{BRAND_TAGLINE}</Text>
      </View>
      {/* 价格透视镜 — a ringed ¥ lens (P0 .lens): ring + handle + ¥ glyph. */}
      <View className="brandhead__lens">
        <Text className="brandhead__lens-yen">¥</Text>
        <View className="brandhead__lens-handle" />
      </View>
    </View>
  );
}
