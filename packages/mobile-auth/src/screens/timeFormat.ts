import { localDayKey, DAY_MS } from '@ridemesh/types';

// How times are written for the person: in the device's own time zone and language. The times
// themselves are instants (see @ridemesh/types), so nothing here changes what is stored.

const clock = () => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayName = () =>
  new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const hourName = () => new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

/** "Today", "Tomorrow", or the day of the week and date, for the local day of a time. */
export function formatDay(at: number, now: number): string {
  const key = localDayKey(at);
  if (key === localDayKey(now)) return 'Today';
  if (key === localDayKey(now + DAY_MS)) return 'Tomorrow';
  return dayName().format(at);
}

/** The clock time, for example "14:35" or "2:35 PM", as the device writes it. */
export function formatClock(at: number): string {
  return clock().format(at);
}

/** A whole hour as a chip label, for example "14" or "2 PM". */
export function formatHour(hour: number): string {
  return hourName().format(new Date(2000, 0, 1, hour));
}

/** A minute as a chip label, for example ":05". */
export function formatMinute(minute: number): string {
  return `:${String(minute).padStart(2, '0')}`;
}

/** A day and a time together, for example "Today, 14:35". */
export function formatWhen(at: number, now: number): string {
  return `${formatDay(at, now)}, ${formatClock(at)}`;
}

/** The device's time zone, for example "Europe/London", for saying which zone times are in. */
export function deviceTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}
