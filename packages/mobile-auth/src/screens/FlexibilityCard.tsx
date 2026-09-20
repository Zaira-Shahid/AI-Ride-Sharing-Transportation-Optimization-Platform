import {
  FLEXIBILITY_LEVEL_LIMITS,
  withLevel,
  type Flexibility,
  type FlexibilityLevel,
} from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CompactButton, SecondaryButton, useAuthTheme } from '../components';
import { ChoiceGroup } from './ChoiceGroup';
import { ToggleRow } from './ToggleRow';

const LEVEL_NAMES: Record<FlexibilityLevel, string> = {
  STRICT: 'Strict',
  BALANCED: 'Balanced',
  FLEXIBLE: 'Flexible',
};

const LEVEL_MEANINGS: Record<FlexibilityLevel, string> = {
  STRICT: 'No meaningful route changes.',
  BALANCED: 'Reasonable walking and route changes.',
  FLEXIBLE: 'Significant shared routing if it saves cost, time or emissions.',
};

const LEVEL_CHOICES = (Object.keys(LEVEL_NAMES) as FlexibilityLevel[]).map((level) => ({
  value: level,
  label: LEVEL_NAMES[level],
}));

/** What a level allows, in words: the numbers the passenger is agreeing to. */
function describeLimits(level: FlexibilityLevel): string {
  const limits = FLEXIBILITY_LEVEL_LIMITS[level];
  return `Walk up to ${limits.maxWalkingDistance} m, up to ${limits.maxExtraTime} extra minutes, up to ${limits.maxDetourDistance} km off the direct route.`;
}

/**
 * How much the passenger will bend for a shared ride: a level (Strict, Balanced or Flexible), which
 * sets how far they will walk, how much extra time they accept and how far their route may leave the
 * direct one, and two switches, whether they will share the ride and whether the route may be
 * changed. The numbers come from the level; they are not typed. It starts as a short summary, like
 * the times, so that it does not cover the map. The ride is never arranged outside these limits
 * without asking the passenger first (spec section 3).
 */
export function FlexibilityCard({
  flexibility,
  onChange,
}: {
  flexibility: Flexibility;
  onChange: (flexibility: Flexibility) => void;
}) {
  const theme = useAuthTheme();
  const [editing, setEditing] = useState(false);
  const cardStyle = [styles.card, { backgroundColor: theme.surface, borderColor: theme.border }];
  const title = (
    <Text accessibilityRole="header" style={[styles.title, { color: theme.textPrimary }]}>
      How flexible are you?
    </Text>
  );

  if (!editing) {
    return (
      <View style={cardStyle} accessibilityLabel="Flexibility">
        {title}
        <View style={styles.summaryRow}>
          <View style={styles.summary}>
            <Text style={[styles.level, { color: theme.textPrimary }]}>
              {LEVEL_NAMES[flexibility.level]}
            </Text>
            <Text style={[styles.line, { color: theme.textPrimary }]}>
              {describeLimits(flexibility.level)}
            </Text>
            <Text style={[styles.line, { color: theme.textSecondary }]}>
              {flexibility.allowSharedRide ? 'Sharing allowed' : 'Sharing not allowed'}
              {' · '}
              {flexibility.allowRouteChange ? 'Route changes allowed' : 'Route changes not allowed'}
            </Text>
          </View>
          <CompactButton
            label="Change flexibility"
            visibleLabel="Change"
            onPress={() => setEditing(true)}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={cardStyle} accessibilityLabel="Flexibility">
      {title}
      <ChoiceGroup
        label="Flexibility level"
        choices={LEVEL_CHOICES}
        value={flexibility.level}
        onChange={(level) => onChange(withLevel(flexibility, level))}
        disabled={false}
      />
      <View style={styles.summary}>
        <Text style={[styles.line, { color: theme.textPrimary }]}>
          {LEVEL_MEANINGS[flexibility.level]}
        </Text>
        <Text style={[styles.line, { color: theme.textSecondary }]}>
          {describeLimits(flexibility.level)}
        </Text>
      </View>
      <ToggleRow
        label="Share my ride"
        description="Other passengers may ride with you."
        value={flexibility.allowSharedRide}
        onChange={(allowSharedRide) => onChange({ ...flexibility, allowSharedRide })}
      />
      <ToggleRow
        label="Allow route changes"
        description="Your level sets this to start with; you can switch it."
        value={flexibility.allowRouteChange}
        onChange={(allowRouteChange) => onChange({ ...flexibility, allowRouteChange })}
      />
      <Text style={[styles.line, { color: theme.textSecondary }]}>
        We will not go beyond these limits without asking you first.
      </Text>
      <SecondaryButton label="Done" onPress={() => setEditing(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[4], gap: spacing[3] },
  title: { fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  summaryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  summary: { flex: 1, gap: spacing[1] },
  level: { fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  line: { fontSize: fontSize.sm },
});
