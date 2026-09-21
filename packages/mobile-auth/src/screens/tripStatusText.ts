import type { TripRequestStatus } from '@ridemesh/types';

/**
 * What each trip status is called for the passenger: a short label (a list row), a title and one line
 * of detail (the ride card on Home). The statuses are the spec's (section 73); the words are ours.
 * Every one is worded as something the system is doing or has done, and none promises a time or a
 * driver that the request does not have yet.
 */
export interface TripStatusText {
  label: string;
  title: string;
  detail: string;
}

export const TRIP_STATUS_TEXT: Record<TripRequestStatus, TripStatusText> = {
  REQUESTED: {
    label: 'Requested',
    title: 'Ride requested',
    detail: 'We have your request. Finding a ride comes next.',
  },
  SEARCHING: {
    label: 'Finding a ride',
    title: 'Finding your ride',
    detail: 'We are looking for a driver going your way.',
  },
  MATCHED: {
    label: 'Driver found',
    title: 'Driver found',
    detail: 'A driver has been found for your trip.',
  },
  PICKUP_ASSIGNED: {
    label: 'Pickup arranged',
    title: 'Pickup arranged',
    detail: 'Your pickup point is set.',
  },
  DRIVER_ARRIVING: {
    label: 'Driver on the way',
    title: 'Your driver is on the way',
    detail: 'Your driver is heading to your pickup.',
  },
  PICKED_UP: {
    label: 'On board',
    title: 'You are on board',
    detail: 'You have been picked up.',
  },
  IN_TRANSIT: {
    label: 'On the way',
    title: 'On your way',
    detail: 'You are on your way to your destination.',
  },
  DROPOFF_APPROACHING: {
    label: 'Almost there',
    title: 'Almost there',
    detail: 'You are close to your destination.',
  },
  COMPLETED: {
    label: 'Completed',
    title: 'Trip completed',
    detail: 'You have arrived.',
  },
  CANCELLED: {
    label: 'Cancelled',
    title: 'Ride cancelled',
    detail: 'This request was cancelled.',
  },
};
