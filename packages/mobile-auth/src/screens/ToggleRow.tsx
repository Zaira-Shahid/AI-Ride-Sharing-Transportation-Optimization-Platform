import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuthTheme } from '../components';

/**
 * An on/off setting with a name and a line of explanation, as one switch a thumb can hit. It is a
 * switch for screen readers (role "switch", on or off), and says "On" or "Off" in words as well as
 * by its look.
 */
export function ToggleRow({
  label,
  description,
  value,
  onChange,
}: {
  label: string;
  description: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const theme = useAuthTheme();
  return (
    <Pressable
      role="switch"
      aria-label={label}
      aria-checked={value}
      onPress={() => onChange(!value)}
      style={[
        styles.row,
        {
          borderColor: value ? theme.accent : theme.border,
          borderWidth: value ? 2 : 1,
          backgroundColor: value ? theme.surface : 'transparent',
        },
      ]}
    >
      <View style={styles.text}>
        <Text style={[styles.label, { color: theme.textPrimary }]}>{label}</Text>
        <Text style={[styles.description, { color: theme.textSecondary }]}>{description}</Text>
      </View>
      <Text style={[styles.state, { color: theme.textPrimary }]}>{value ? 'On' : 'Off'}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    borderRadius: radius.md,
  },
  text: { flex: 1, gap: spacing[1] },
  label: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
  description: { fontSize: fontSize.sm },
  state: { fontSize: fontSize.base, fontWeight: fontWeight.semibold },
});
