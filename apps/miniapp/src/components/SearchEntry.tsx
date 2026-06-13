// Search entry — PLACEHOLDER only (P0 ".search"). Looks like a search bar but is
// NOT a real input: it never focuses, never accepts text, never requests. Tapping
// it just fires onClick (the page wires a "敬请期待" toast). The real search is
// P4.
//
// The magnifier glyph is drawn with bordered Views using currentColor (which
// inherits the placeholder text color, var(--muted)) — NO inline hex.
import { View, Text } from '@tarojs/components';

import './SearchEntry.css';

export interface SearchEntryProps {
  /** Tap handler — supplied by the page (a "敬请期待" toast). No request. */
  onClick: () => void;
}

export const SEARCH_PLACEHOLDER = '搜软饮名，如 元气森林 / 无糖可乐';

export default function SearchEntry({ onClick }: SearchEntryProps) {
  return (
    <View className="searchentry" onClick={onClick}>
      {/* Magnifier: a ring + a handle, stroked in currentColor (inherits --muted). */}
      <View className="searchentry__icon">
        <View className="searchentry__icon-ring" />
        <View className="searchentry__icon-handle" />
      </View>
      <Text className="searchentry__placeholder">{SEARCH_PLACEHOLDER}</Text>
    </View>
  );
}
