import {
  describeAuthError,
  saveVehicle,
  setVehicleCapacity,
  type AuthFailure,
  type VehicleData,
} from '@ridemesh/firebase';
import { useAuth, useVehicle } from '@ridemesh/firebase/react';
import {
  SEAT_CAPACITY_MAX,
  SEAT_CAPACITY_MIN,
  VEHICLE_TYPES,
  validateVehicle,
  type VehicleField,
  type VehicleFormValues,
  type VehicleType,
} from '@ridemesh/types';
import { fontSize, fontWeight, radius, spacing } from '@ridemesh/ui';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Notice,
  PrimaryButton,
  SecondaryButton,
  TextButton,
  TextField,
  useAuthTheme,
} from '../components';
import { DetailRow, ReviewStatus } from './ReviewStatus';

const TYPE_LABELS: Record<VehicleType, string> = {
  CAR: 'Car',
  VAN: 'Van',
  MINIBUS: 'Minibus',
};

type FieldErrors = Partial<Record<VehicleField, string>>;

interface Choice<Value extends string | number> {
  value: Value;
  label: string;
}

/** A row of exclusive choices (radio buttons) that is quick to use with a thumb. */
function ChoiceGroup<Value extends string | number>({
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

const TYPE_CHOICES = VEHICLE_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] }));

const SEAT_CHOICES = Array.from(
  { length: SEAT_CAPACITY_MAX - SEAT_CAPACITY_MIN + 1 },
  (_unused, index) => ({
    value: SEAT_CAPACITY_MIN + index,
    label: String(SEAT_CAPACITY_MIN + index),
  }),
);

/** Passenger seats of the saved vehicle. */
function SeatsControl({ vehicle }: { vehicle: VehicleData }) {
  const theme = useAuthTheme();
  const { client } = useAuth();
  const stored = vehicle.seatCapacity;
  const [selected, setSelected] = useState<number | null>(stored);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Follow the stored value, for example right after it has been saved.
  useEffect(() => setSelected(stored), [stored]);

  // More seats than the reviewed number, or seats never reviewed, mean a new review.
  const needsReview =
    vehicle.verificationStatus === 'VERIFIED' &&
    selected !== null &&
    (stored === null || selected > stored);

  const choose = (seats: number) => {
    setSelected(seats);
    setFailure(null);
    setJustSaved(false);
  };

  const save = async () => {
    setFailure(null);
    setJustSaved(false);
    setSaving(true);
    try {
      await setVehicleCapacity(client, selected);
      setJustSaved(true);
    } catch (error) {
      setFailure(describeAuthError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.seats}>
      <ChoiceGroup
        label="Passenger seats"
        choices={SEAT_CHOICES}
        value={selected}
        onChange={choose}
        disabled={saving}
      />
      <Text style={[styles.message, { color: theme.textSecondary }]}>
        {stored === null
          ? 'Not set yet. Count the seats for passengers, not your own.'
          : 'Seats for passengers, not counting your own.'}
      </Text>
      {needsReview ? (
        <Text style={[styles.message, { color: theme.textSecondary }]}>
          More seats means your vehicle will be reviewed again.
        </Text>
      ) : null}
      {justSaved ? <Notice tone="info">Your seats have been saved.</Notice> : null}
      {failure ? <Notice tone="error">{failure.message}</Notice> : null}
      <PrimaryButton
        label={saving ? 'Saving' : failure?.retryable ? 'Try again' : 'Save seats'}
        onPress={() => void save()}
        loading={saving}
        disabled={selected === null || selected === stored}
      />
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
      <ChoiceGroup
        label="Vehicle type"
        choices={TYPE_CHOICES}
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
          <ReviewStatus
            target="VEHICLE"
            status={current.verificationStatus}
            reason={current.verificationReason}
          />
          <SeatsControl vehicle={current} />
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
  field: { gap: spacing[1] },
  seats: { gap: spacing[3] },
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
