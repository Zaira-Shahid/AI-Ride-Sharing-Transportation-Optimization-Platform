import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

interface ScreenShellProps {
  title: string;
  description: string;
}

export function ScreenShell({ title, description }: ScreenShellProps) {
  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing[4],
    backgroundColor: theme.background,
  },
  card: {
    padding: spacing[6],
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    gap: spacing[2],
  },
  title: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: theme.textPrimary,
  },
  description: {
    fontSize: fontSize.sm,
    color: theme.textSecondary,
  },
});
