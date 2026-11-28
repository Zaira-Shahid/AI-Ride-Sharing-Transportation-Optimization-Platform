import type { InputHTMLAttributes } from 'react';
import { inputClass } from '../lib/ui';

interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'className'
> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: string | undefined;
}

/** A labelled input. The label, hint and error are tied to the input for screen readers. */
export function TextField({ label, value, onChange, error, hint, id, ...rest }: TextFieldProps) {
  const fieldId = id ?? `field-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const describedBy = [hint ? `${fieldId}-hint` : null, error ? `${fieldId}-error` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="text-sm text-clean-white/80">
      <label htmlFor={fieldId}>{label}</label>
      <input
        {...rest}
        id={fieldId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={inputClass}
      />
      {hint ? (
        <span id={`${fieldId}-hint`} className="mt-1 block text-xs text-clean-white/60">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${fieldId}-error`} className="mt-1 block text-xs text-danger-text">
          {error}
        </span>
      ) : null}
    </div>
  );
}
