// Attribute chip — PLACEHOLDER / disabled (P0 ".chip"). Pure presentational, no
// side effects: tapping does NOT request, does NOT reorder the list. Real
// attribute filtering is P3. The page renders a static set (e.g. 无糖 / 气泡 /
// 进口) in this disabled state.
//
// Two visuals: `active` (the P0 .chip.on solid-blue treatment, e.g. a default
// "全部") and the default disabled placeholder outline. `disabled` is the
// expected state for the placeholder set; it dims the chip and is purely visual.
import { View, Text } from '@tarojs/components';

import './Chip.css';

export interface ChipProps {
  /** Chip label, e.g. 无糖 / 气泡 / 进口. */
  label: string;
  /** Active (solid blue) visual — e.g. a default "全部". */
  active?: boolean;
  /** Placeholder/disabled visual (dimmed, non-interactive look). */
  disabled?: boolean;
}

export default function Chip({ label, active = false, disabled = false }: ChipProps) {
  const cls = ['chip', active ? 'chip--active' : '', disabled ? 'chip--disabled' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <View className={cls}>
      <Text className="chip__label">{label}</Text>
    </View>
  );
}
