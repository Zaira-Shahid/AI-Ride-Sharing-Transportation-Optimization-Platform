import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuthTheme } from '../components';

export interface Chip {
  /** A stable key. */
  key: string;
  /** What is shown, and what a screen reader says. */
  label: string;
  selected: boolean;
  onPress: () => void;
}

/**
 * A row of exclusive choices (radio buttons) that scrolls sideways when there are more than fit, for
 * choices such as the hours of a day. ChoiceGroup is the fixed row for a handful.
 */
export function ChipRow({ label, chips }: { label: string; chips: readonly Chip[] }) {
  const theme = useAuthTheme();
  return (
    <View style={styles.group}>
      <Text style={[styles.label, { color: theme.textPrimary }]}>{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        role="radiogroup"
        aria-label={label}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        {chips.map((chip) => (
          <Pressable
            key={chip.key}
            role="radio"
            aria-label={chip.label}
            aria-checked={chip.selected}
            onPress={chip.onPress}
            style={[
              styles.chip,
              {
                borderColor: chip.selected ? theme.accent : theme.border,
                backgroundColor: chip.selected ? theme.surface : 'transparent',
                borderWidth: chip.selected ? 2 : 1,
              },
            ]}
          >
            <Text style={[styles.chipLabel, { color: theme.textPrimary }]}>{chip.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing[1] },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  row: { gap: spacing[2], paddingVertical: spacing[1] },
  chip: {
    minWidth: 56,
    minHeight: 48,
    paddingHorizontal: spacing[3],
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipLabel: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
});
