import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuthTheme } from '../components';

export interface Choice<Value extends string | number> {
  value: Value;
  label: string;
}

/** A row of exclusive choices (radio buttons) that is quick to use with a thumb. */
export function ChoiceGroup<Value extends string | number>({
  label,
  choices,
  value,
  onChange,
  error,
  disabled,
}: {
  label: string;
  choices: readonly Choice<Value>[];
  value: Value | '' | null;
  onChange: (value: Value) => void;
  error?: string | undefined;
  disabled: boolean;
}) {
  const theme = useAuthTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.textPrimary }]}>{label}</Text>
      <View role="radiogroup" aria-label={label} style={styles.choices}>
        {choices.map((choice) => {
          const selected = value === choice.value;
          return (
            <Pressable
              key={choice.value}
              role="radio"
              aria-label={choice.label}
              aria-checked={selected}
              aria-disabled={disabled}
              disabled={disabled}
              onPress={() => onChange(choice.value)}
              style={[
                styles.choice,
                {
                  borderColor: selected ? theme.accent : error ? theme.danger : theme.border,
                  backgroundColor: selected ? theme.surface : 'transparent',
                  borderWidth: selected ? 2 : 1,
                },
              ]}
            >
              <Text style={[styles.choiceLabel, { color: theme.textPrimary }]}>{choice.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={[styles.message, { color: theme.danger }]}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing[1] },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  message: { fontSize: fontSize.sm },
  choices: { flexDirection: 'row', gap: spacing[2] },
  choice: {
    flex: 1,
    minHeight: 52,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceLabel: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
});
