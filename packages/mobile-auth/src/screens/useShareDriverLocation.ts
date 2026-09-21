import { updateDriverLocation } from '@ridemesh/firebase';
import { useAuth } from '@ridemesh/firebase/react';
import { useLocationWatch, type LocationWatchStatus } from '@ridemesh/map';
import { shouldSendLocation, type LocationSample } from '@ridemesh/types';
import { useCallback, useEffect, useRef } from 'react';

/**
 * Shares the online driver's position with the server, sparingly (spec section 72: never every
 * second). While `online` is true the device's location is followed; each reading goes through
 * shouldSendLocation, which decides from the last one that was sent (at most every 30 seconds and
 * only after 50 metres of movement, a heartbeat every 5 minutes when standing still, nothing
 * inaccurate), and only then is it sent through updateDriverLocation. The server checks again.
 *
 * When `online` becomes false the watch stops and what was last sent is forgotten, so the next time
 * the driver goes online the first usable reading is sent. Nothing is kept on the device. A send
 * that fails is simply tried again with a later reading. Returns the state of the watch, so the
 * screen can say when location is off.
 */
export function useShareDriverLocation(online: boolean): { status: LocationWatchStatus } {
  const { client } = useAuth();
  const lastSent = useRef<LocationSample | null>(null);

  useEffect(() => {
    if (!online) lastSent.current = null;
  }, [online]);

  const onReading = useCallback(
    (reading: LocationSample) => {
      if (!shouldSendLocation(lastSent.current, reading)) return;
      const previous = lastSent.current;
      // Counted as sent straight away, so that readings arriving while this one is on its way do not
      // send it twice; put back if the send fails, so a later reading tries again.
      lastSent.current = reading;
      void updateDriverLocation(client, reading).catch(() => {
        if (lastSent.current === reading) lastSent.current = previous;
      });
    },
    [client],
  );

  return useLocationWatch(online, onReading);
}
