import { useEffect, useState } from 'react';

/**
 * The current time, refreshed every so often, so that what depends on "now" (which times can still
 * be chosen, whether a chosen time has become too soon) stays right while a screen is left open.
 * The server checks with its own clock when the trip is requested; this only keeps the screen honest.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
