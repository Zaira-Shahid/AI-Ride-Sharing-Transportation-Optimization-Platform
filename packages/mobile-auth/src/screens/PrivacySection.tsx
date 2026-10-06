import { deleteMyAccount, exportMyData } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import { cardSurface, fontSize, fontWeight, spacing } from '@ridemesh/ui';
import { useState } from 'react';
import { Platform, Share, StyleSheet, View } from 'react-native';
import { Text } from '../typography';
import {
  ConfirmDialog,
  Notice,
  PrimaryButton,
  SecondaryButton,
  TextButton,
  TextField,
  useAuthTheme,
} from '../components';
import {
  DELETE_FAILED,
  EXPORT_FAILED,
  describeDataRightsError,
  exportFileName,
  exportJson,
  deleteDialogMessage,
  isDeleteConfirmed,
  privacyNotes,
  type PrivacyRole,
} from './privacyData';

// Phase 14 (Privacy compliance): a rider's way to the export and account deletion built in
// functions/src/dataRights.ts (passenger) and driverDataRights.ts (driver). Both apps show it; only the
// wording differs, since the server picks the right export and deletion by the signed-in role.
//
// Export: the web build downloads a .json file, a phone opens the system share sheet with the JSON
// text - neither needs a file-system dependency. Deletion is two steps on purpose: a dialog saying
// what goes and what stays, then the passenger types DELETE (the server refuses anything else). A
// refusal from the server (a ride still open, a payment pending, a dispute, too many tries) is shown
// as written; on success the session is ended and the app returns to the welcome screen.

/** Saves text as a file in a browser. Only called on web. */
function downloadJson(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

type DeleteStep = 'idle' | 'confirming' | 'typing';

export function PrivacySection({ role }: { role: PrivacyRole }) {
  const theme = useAuthTheme();
  const { client, signOut } = useAuth();

  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const [step, setStep] = useState<DeleteStep>('idle');
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const runExport = async () => {
    setExportNotice(null);
    setExportError(null);
    setExporting(true);
    try {
      const data = await exportMyData(client);
      const text = exportJson(data);
      if (Platform.OS === 'web') {
        downloadJson(exportFileName(data.exportedAt), text);
      } else {
        await Share.share({ title: 'My RideMesh data', message: text });
      }
      setExportNotice(
        data.truncated
          ? 'Your data is ready. It is very large, so some records were left out.'
          : Platform.OS === 'web'
            ? 'Your data was downloaded as a file.'
            : 'Your data is ready to save or share.',
      );
    } catch (error) {
      setExportError(describeDataRightsError(error, EXPORT_FAILED));
    } finally {
      setExporting(false);
    }
  };

  const cancelDelete = () => {
    setStep('idle');
    setTyped('');
    setDeleteError(null);
  };

  const runDelete = async () => {
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteMyAccount(client);
    } catch (error) {
      setDeleteError(describeDataRightsError(error, DELETE_FAILED));
      setDeleting(false);
      return;
    }
    // The account no longer exists; ending the local session returns the app to the welcome screen
    // (and unmounts this section, so nothing is set after it).
    try {
      await signOut();
    } catch {
      setDeleteError('Your account was deleted. Please close and reopen the app.');
      setDeleting(false);
    }
  };

  return (
    <View
      style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
      accessibilityLabel="Privacy and data"
    >
      <Text accessibilityRole="header" style={[styles.heading, { color: theme.textPrimary }]}>
        Privacy and data
      </Text>
      <View style={styles.notes}>
        {privacyNotes(role).map((note) => (
          <Text key={note} style={[styles.note, { color: theme.textSecondary }]}>
            {'•'} {note}
          </Text>
        ))}
      </View>

      {exportNotice ? <Notice tone="info">{exportNotice}</Notice> : null}
      {exportError ? <Notice tone="error">{exportError}</Notice> : null}
      <SecondaryButton
        label={exporting ? 'Preparing your data' : 'Download my data'}
        onPress={() => void runExport()}
        disabled={exporting || deleting}
      />

      {deleteError ? <Notice tone="error">{deleteError}</Notice> : null}
      {step === 'typing' ? (
        <>
          <TextField
            label="Type DELETE to confirm"
            value={typed}
            onChangeText={setTyped}
            autoCapitalize="characters"
            editable={!deleting}
            hint="This cannot be undone."
          />
          <PrimaryButton
            label="Permanently delete my account"
            onPress={() => void runDelete()}
            loading={deleting}
            disabled={!isDeleteConfirmed(typed)}
          />
          <TextButton label="Cancel deletion" onPress={cancelDelete} disabled={deleting} />
        </>
      ) : (
        <SecondaryButton
          label="Delete my account"
          onPress={() => {
            setDeleteError(null);
            setStep('confirming');
          }}
          disabled={exporting}
        />
      )}

      <ConfirmDialog
        visible={step === 'confirming'}
        title="Delete your account?"
        message={deleteDialogMessage(role)}
        confirmLabel="Continue"
        onConfirm={() => setStep('typing')}
        onCancel={cancelDelete}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { ...cardSurface, padding: spacing[6], gap: spacing[3] },
  heading: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  notes: { gap: spacing[1] },
  note: { fontSize: fontSize.sm },
});
