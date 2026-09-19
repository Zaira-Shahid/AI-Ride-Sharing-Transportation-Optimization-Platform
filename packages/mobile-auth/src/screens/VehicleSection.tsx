import {
  describeAuthError,
  saveVehicle,
  type AuthFailure,
  type VehicleData,
} from '@ridemesh/firebase';
import { useAuth, useVehicle } from '@ridemesh/firebase/react';
import {
  VEHICLE_TYPES,
  validateVehicle,
  type VehicleField,
  type VehicleFormValues,
  type VehicleType,
  type VehicleVerificationStatus,
} from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Notice,
  PrimaryButton,
  SecondaryButton,
  TextButton,
  TextField,
  useAuthTheme,
} from '../components';

const TYPE_LABELS: Record<VehicleType, string> = {
  CAR: 'Car',
  VAN: 'Van',
  MINIBUS: 'Minibus',
};

const VERIFICATION_LABELS: Record<VehicleVerificationStatus, string> = {
  PENDING: 'Pending review',
  VERIFIED: 'Verified',
  REJECTED: 'Not approved',
};

type FieldErrors = Partial<Record<VehicleField, string>>;

function TypeChoice({
  value,
  onChange,
  error,
  disabled,
}: {
  value: VehicleFormValues['type'];
  onChange: (type: VehicleType) => void;
  error: string | undefined;
  disabled: boolean;
}) {
  const theme = useAuthTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.textPrimary }]}>Vehicle type</Text>
      <View role="radiogroup" aria-label="Vehicle type" style={styles.choices}>
        {VEHICLE_TYPES.map((type) => {
          const selected = value === type;
          return (
            <Pressable
              key={type}
              role="radio"
              aria-label={TYPE_LABELS[type]}
              aria-checked={selected}
              aria-disabled={disabled}
              disabled={disabled}
              onPress={() => onChange(type)}
              style={[
                styles.choice,
                {
                  borderColor: selected ? theme.accent : error ? theme.danger : theme.border,
                  backgroundColor: selected ? theme.surface : 'transparent',
                  borderWidth: selected ? 2 : 1,
                },
              ]}
            >
              <Text style={[styles.choiceLabel, { color: theme.textPrimary }]}>
                {TYPE_LABELS[type]}
              </Text>
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

function VehicleForm({
  vehicle,
  onSaved,
  onCancel,
}: {
  vehicle: VehicleData | undefined;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const theme = useAuthTheme();
  const { client } = useAuth();
  const [values, setValues] = useState<VehicleFormValues>({
    type: vehicle?.type ?? '',
    make: vehicle?.make ?? '',
    model: vehicle?.model ?? '',
    plateNumber: vehicle?.plateNumber ?? '',
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <Field extends VehicleField>(field: Field) => {
    return (value: VehicleFormValues[Field]) => {
      setValues((current) => ({ ...current, [field]: value }));
      setFieldErrors((current) => ({ ...current, [field]: undefined }));
      setFailure(null);
    };
  };

  const save = async () => {
    setFailure(null);
    const validation = validateVehicle(values);
    if (!validation.ok) {
      setFieldErrors(validation.errors);
      return;
    }
    setFieldErrors({});
    setSaving(true);
    try {
      await saveVehicle(client, values);
      onSaved();
    } catch (error) {
      const described = describeAuthError(error);
      if (described.kind === 'plate-in-use') {
        setFieldErrors({ plateNumber: described.message });
      } else {
        setFailure(described);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {vehicle?.verificationStatus === 'VERIFIED' ? (
        <Text style={[styles.message, { color: theme.textSecondary }]}>
          Changing these details means your vehicle will be reviewed again.
        </Text>
      ) : null}
      {failure ? <Notice tone="error">{failure.message}</Notice> : null}
      <TypeChoice
        value={values.type}
        onChange={set('type')}
        error={fieldErrors.type}
        disabled={saving}
      />
      <TextField
        label="Make"
        value={values.make}
        onChangeText={set('make')}
        error={fieldErrors.make}
        autoCapitalize="words"
        returnKeyType="next"
        editable={!saving}
      />
      <TextField
        label="Model"
        value={values.model}
        onChangeText={set('model')}
        error={fieldErrors.model}
        autoCapitalize="words"
        returnKeyType="next"
        editable={!saving}
      />
      <TextField
        label="Plate number"
        value={values.plateNumber}
        onChangeText={set('plateNumber')}
        error={fieldErrors.plateNumber}
        autoCapitalize="characters"
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        editable={!saving}
      />
      <PrimaryButton
        label={saving ? 'Saving' : failure?.retryable ? 'Try again' : 'Save vehicle'}
        onPress={() => void save()}
        loading={saving}
      />
      <TextButton label="Cancel" onPress={onCancel} disabled={saving} />
    </>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const theme = useAuthTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.caption, { color: theme.textSecondary }]}>{label}</Text>
      <Text style={[styles.value, { color: theme.textPrimary }]}>{value}</Text>
    </View>
  );
}

/** The driver's vehicle: shown, added or edited. Rendered in the driver app only. */
export function VehicleSection() {
  const theme = useAuthTheme();
  const vehicle = useVehicle();
  const [editing, setEditing] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const card = [styles.card, { backgroundColor: theme.surface, borderColor: theme.border }];

  if (vehicle.status === 'loading') {
    return <ActivityIndicator accessibilityLabel="Loading your vehicle" color={theme.accent} />;
  }
  if (vehicle.status === 'error') {
    return (
      <>
        <Notice tone="error">We could not load your vehicle. Please try again.</Notice>
        <SecondaryButton label="Try again" onPress={vehicle.retry} />
      </>
    );
  }

  const current = vehicle.status === 'ready' ? vehicle.vehicle : undefined;

  if (editing) {
    return (
      <View style={card} accessibilityLabel="Vehicle form">
        <Text style={[styles.heading, { color: theme.textPrimary }]}>
          {current ? 'Edit your vehicle' : 'Add your vehicle'}
        </Text>
        <VehicleForm
          vehicle={current}
          onSaved={() => {
            setEditing(false);
            setJustSaved(true);
          }}
          onCancel={() => setEditing(false)}
        />
      </View>
    );
  }

  const startEditing = () => {
    setJustSaved(false);
    setEditing(true);
  };

  return (
    <View style={card} accessibilityLabel="Your vehicle">
      <Text style={[styles.heading, { color: theme.textPrimary }]}>Your vehicle</Text>
      {justSaved ? <Notice tone="info">Your vehicle has been saved.</Notice> : null}
      {current ? (
        <>
          <DetailRow label="Type" value={TYPE_LABELS[current.type]} />
          <DetailRow label="Vehicle" value={`${current.make} ${current.model}`} />
          <DetailRow label="Plate number" value={current.plateNumber} />
          <DetailRow label="Verification" value={VERIFICATION_LABELS[current.verificationStatus]} />
          <SecondaryButton label="Edit vehicle" onPress={startEditing} />
        </>
      ) : (
        <>
          <Text style={[styles.caption, { color: theme.textSecondary }]}>
            Add the vehicle you will drive so it can be reviewed.
          </Text>
          <PrimaryButton label="Add vehicle" onPress={startEditing} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: radius.lg, padding: spacing[6], gap: spacing[4] },
  heading: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  caption: { fontSize: fontSize.sm },
  message: { fontSize: fontSize.sm },
  row: { gap: spacing[1] },
  value: { fontSize: fontSize.base, fontWeight: fontWeight.medium },
  field: { gap: spacing[1] },
  label: { fontSize: fontSize.sm, fontWeight: fontWeight.medium },
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
