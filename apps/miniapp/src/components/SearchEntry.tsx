// Search entry — a real Taro input. On confirm it normalizes by code points and
// navigates to the shared board page with `q=<encoded term>`. The board filters
// the already cached rankings snapshot locally; search itself sends no request.
// Still read-only: no parse, unit-price calculation, entry, scan, or photo path.
//
// The magnifier glyph is drawn with bordered Views using currentColor (which
// inherits the placeholder text color, var(--muted)) — NO inline hex.
import { View, Input } from "@tarojs/components";
import type { BaseEventOrig, InputProps } from "@tarojs/components";
import Taro from "@tarojs/taro";

import { normalizeSearchTerm } from "./searchTerm";
import "./SearchEntry.css";

export const SEARCH_PLACEHOLDER = "搜软饮名，如 元气森林 / 无糖可乐";

export default function SearchEntry() {
  const onConfirm = (e: BaseEventOrig<InputProps.inputValueEventDetail>) => {
    const result = normalizeSearchTerm(e.detail.value ?? "");
    if (result.kind === "empty") return; // no intent → no nav, no request
    if (result.kind === "too-short") {
      // Single code point is too broad for the local catalogue → hint, no nav.
      void Taro.showToast({ title: "至少输入 2 个字", icon: "none" });
      return;
    }
    // ≥2 code points: board derives the title and local filter from decoded q.
    void Taro.navigateTo({
      url: `/pages/board/index?q=${encodeURIComponent(result.term)}`,
    });
  };

  return (
    <View className="searchentry">
      {/* Magnifier: a ring + a handle, stroked in currentColor (inherits --muted). */}
      <View className="searchentry__icon">
        <View className="searchentry__icon-ring" />
        <View className="searchentry__icon-handle" />
      </View>
      <Input
        className="searchentry__input"
        type="text"
        confirmType="search"
        placeholder={SEARCH_PLACEHOLDER}
        placeholderClass="searchentry__placeholder"
        onConfirm={onConfirm}
      />
    </View>
  );
}
