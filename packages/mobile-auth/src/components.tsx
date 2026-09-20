import { fontSize, fontWeight, palette, radius, spacing, type ThemeColors } from '@ridemesh/ui';
import { createContext, useContext, type ReactNode, type RefObject } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ThemeContext = createContext<ThemeColors | null>(null);

export function useAuthTheme(): ThemeColors {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('Authentication components must be rendered inside an AuthFrame.');
  return theme;
}

/**
 * Gives the components in this file their theme, for a screen that lays itself out instead of
 * using an AuthFrame (for example one that is mostly a map).
 */
export function AuthThemeProvider({
  theme,
  children,
}: {
  theme: ThemeColors;
  children: ReactNode;
}) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function AuthFrame({
  theme,
  children,
  insets: applyInsets = true,
}: {
  theme: ThemeColors;
  children: ReactNode;
  /** Set to false inside a screen that already has a header and tab bar. */
  insets?: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
    <ThemeContext.Provider value={theme}>
      <KeyboardAvoidingView
        style={[styles.flex, { backgroundColor: theme.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            applyInsets
              ? { paddingTop: insets.top + spacing[8], paddingBottom: insets.bottom + spacing[8] }
              : { paddingVertical: spacing[6] },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </ThemeContext.Provider>
  );
}

export function Heading({ title, subtitle }: { title: string; subtitle?: string }) {
  const theme = useAuthTheme();
  return (
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={[styles.title, { color: theme.textPrimary }]}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={[styles.subtitle, { color: theme.textSecondary }]}>{subtitle}</Text>
      ) : null}
    </View>
  );
}

interface TextFieldProps extends Pick<
  TextInputProps,
  | 'autoCapitalize'
  | 'autoComplete'
  | 'keyboardType'
  | 'returnKeyType'
  | 'textContentType'
  | 'onSubmitEditing'
  | 'editable'
> {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  error?: string | undefined;
  hint?: string;
  secure?: boolean;
  inputRef?: RefObject<TextInput | null>;
}

export function TextField({
  label,
  value,
  onChangeText,
  error,
  hint,
  secure = false,
  inputRef,
  ...inputProps
}: TextFieldProps) {
  const theme = useAuthTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.textPrimary }]}>{label}</Text>
      <TextInput
        ref={inputRef}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure}
        autoCorrect={false}
        placeholderTextColor={theme.textSecondary}
        style={[
          styles.input,
          {
            color: theme.textPrimary,
            backgroundColor: theme.surface,
            borderColor: error ? theme.danger : theme.border,
          },
        ]}
        {...inputProps}
      />
      {error ? (
        <Text accessibilityLiveRegion="polite" style={[styles.message, { color: theme.danger }]}>
          {error}
        </Text>
      ) : hint ? (
        <Text style={[styles.message, { color: theme.textSecondary }]}>{hint}</Text>
      ) : null}
    </View>
  );
}

interface ButtonProps {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
}

export function PrimaryButton({ label, onPress, loading = false, disabled = false }: ButtonProps) {
  const theme = useAuthTheme();
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={[styles.button, { backgroundColor: theme.accent, opacity: inactive ? 0.6 : 1 }]}
    >
      {loading ? (
        <ActivityIndicator color={palette.midnightNavy} />
      ) : (
        <Text style={[styles.buttonLabel, { color: palette.midnightNavy }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export function SecondaryButton({ label, onPress, disabled = false }: ButtonProps) {
  const theme = useAuthTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        { borderWidth: 1, borderColor: theme.textPrimary, opacity: disabled ? 0.5 : 1 },
      ]}
    >
      <Text style={[styles.buttonLabel, { color: theme.textPrimary }]}>{label}</Text>
    </Pressable>
  );
}

export function TextButton({ label, onPress, disabled = false }: ButtonProps) {
  const theme = useAuthTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.textButton, { opacity: disabled ? 0.5 : 1 }]}
    >
      <Text style={[styles.textButtonLabel, { color: theme.textPrimary }]}>{label}</Text>
    </Pressable>
  );
}

interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** A confirmation prompt that behaves the same on iOS, Android and web (Alert does not on web). */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const theme = useAuthTheme();
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onCancel}>
      <View style={styles.overlay}>
        <View
          role="alertdialog"
          aria-modal
          accessibilityViewIsModal
          style={[styles.dialog, { backgroundColor: theme.surface, borderColor: theme.border }]}
        >
          <Text
            accessibilityRole="header"
            style={[styles.dialogTitle, { color: theme.textPrimary }]}
          >
            {title}
          </Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>{message}</Text>
          <PrimaryButton label={confirmLabel} onPress={onConfirm} loading={busy} />
          <SecondaryButton label={cancelLabel} onPress={onCancel} disabled={busy} />
        </View>
      </View>
    </Modal>
  );
}

export function Notice({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }) {
  const theme = useAuthTheme();
  const color = tone === 'error' ? theme.danger : theme.accent;
  return (
    <View
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
      style={[styles.notice, { borderColor: color, backgroundColor: theme.surface }]}
    >
      <Text style={[styles.noticeText, { color: theme.textPrimary }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: spacing[6], gap: spacing[4] },
  heading: { gap: spacing[2], marginBottom: spacing[2] },
  title: { fontSize: fontSize['3xl'], fontWeight: fontWeight.bold },
  subtitle: { fontSize: fontSize.base },
  field: { gap: spacing[1] },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.medium },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing[4],
    fontSize: fontSize.base,
  },
  message: { fontSize: fontSize.sm },
  button: {
    minHeight: 52,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing[4],
  },
  buttonLabel: { fontSize: fontSize.base, fontWeight: fontWeight.semibold },
  textButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  textButtonLabel: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing[6],
    backgroundColor: 'rgba(11, 18, 32, 0.6)',
  },
  dialog: {
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: spacing[6],
    gap: spacing[4],
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  dialogTitle: { fontSize: fontSize.xl, fontWeight: fontWeight.bold },
  notice: { borderWidth: 1, borderRadius: radius.md, padding: spacing[4] },
  noticeText: { fontSize: fontSize.sm },
});
