// Scope bar — STATIC range note (P0 ".tape"). A static operational statement of
// the ranking's scope + unit only. NO dynamic count N, NO "更新于 X月X日" collect
// date (D6 / spec): the /rankings v1 contract has no count/collect-time field,
// and surfacing a fake dynamic value would be pseudo-honest. Real freshness is
// P8, real category filtering is P3. Pure presentational, no props.
import { View, Text } from '@tarojs/components';

import { LANDING_SCOPE_TEXT } from '../pages/index/config';
import './ScopeBar.css';

/** Static scope wording, aligned with /rankings v1 data (in-ranking = per100ml
 *  non-null, i.e. Sam's soft drinks) and the per100ml unit. NO dynamic values.
 *
 *  Names the cohort `LANDING_COHORT` (pages/index/config.ts) selects — change
 *  one and the board renders under a header describing a different cohort. */
export const SCOPE_TEXT = LANDING_SCOPE_TEXT;

export default function ScopeBar() {
  return (
    <View className="scopebar">
      <Text className="scopebar__text">{SCOPE_TEXT}</Text>
    </View>
  );
}
