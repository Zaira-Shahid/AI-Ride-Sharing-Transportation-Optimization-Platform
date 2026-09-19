import { describeAuthError, requestReview, type AuthFailure } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import type { ReviewTarget } from '@ridemesh/types';
import { fontSize, fontWeight, spacing } from '@ridemesh/ui';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Notice, SecondaryButton, useAuthTheme } from '../components';

type Status = 'PENDING' | 'VERIFIED' | 'REJECTED';

const VERIFICATION_LABELS: Record<Status, string> = {
  PENDING: 'Pending review',
  VERIFIED: 'Verified',
  REJECTED: 'Not approved',
};

const SUBJECT: Record<ReviewTarget, string> = { DRIVER: 'driver', VEHICLE: 'vehicle' };

export function DetailRow({ label, value }: { label: string; value: string }) {
  const theme = useAuthTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.caption, { color: theme.textSecondary }]}>{label}</Text>
      <Text style={[styles.value, { color: theme.textPrimary }]}>{value}</Text>
    </View>
  );
}

/**
 * The verification of a driver profile or a vehicle: its status and, once staff have rejected it,
 * why, with a way to ask for a new review. Staff decide; the person can never verify themselves.
 */
export function ReviewStatus({
  target,
  status,
  reason,
}: {
  target: ReviewTarget;
  status: Status;
  reason: string | null;
}) {
  const theme = useAuthTheme();
  const { client } = useAuth();
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [asking, setAsking] = useState(false);

  const ask = async () => {
    setFailure(null);
    setAsking(true);
    try {
      await requestReview(client, target);
    } catch (error) {
      setFailure(describeAuthError(error));
    } finally {
      setAsking(false);
    }
  };

  return (
    <>
      <DetailRow label="Verification" value={VERIFICATION_LABELS[status]} />
      {status === 'PENDING' ? (
        <Text style={[styles.caption, { color: theme.textSecondary }]}>
          Our team has not reviewed this yet.
        </Text>
      ) : null}
      {status === 'REJECTED' ? (
        <>
          <Text style={[styles.caption, { color: theme.textSecondary }]}>
            {reason ? `Reason: ${reason}` : 'No reason was given.'}
          </Text>
          {failure ? <Notice tone="error">{failure.message}</Notice> : null}
          <SecondaryButton
            label={`Request ${SUBJECT[target]} review`}
            onPress={() => void ask()}
            disabled={asking}
          />
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  row: { gap: spacing[1] },
  caption: { fontSize: fontSize.sm },
  value: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
});
