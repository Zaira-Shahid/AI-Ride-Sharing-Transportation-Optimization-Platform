import { z } from 'zod';

export const TRIP_REQUEST_STATUSES = [
  'REQUESTED',
  'SEARCHING',
  'MATCHED',
  'PICKUP_ASSIGNED',
  'DRIVER_ARRIVING',
  'PICKED_UP',
  'IN_TRANSIT',
  'DROPOFF_APPROACHING',
  'COMPLETED',
  'CANCELLED',
] as const;
export const tripRequestStatusSchema = z.enum(TRIP_REQUEST_STATUSES);
export type TripRequestStatus = z.infer<typeof tripRequestStatusSchema>;

export const DRIVER_JOURNEY_STATUSES = [
  'DRAFT',
  'AVAILABLE',
  'MATCHING',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const;
export const driverJourneyStatusSchema = z.enum(DRIVER_JOURNEY_STATUSES);
export type DriverJourneyStatus = z.infer<typeof driverJourneyStatusSchema>;

export const PAYMENT_STATUSES = [
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'DISPUTED',
] as const;
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const STOP_TYPES = ['PICKUP', 'DROPOFF', 'DRIVER_ORIGIN', 'DRIVER_DESTINATION'] as const;
export const stopTypeSchema = z.enum(STOP_TYPES);
export type StopType = z.infer<typeof stopTypeSchema>;

export const FLEXIBILITY_LEVELS = ['STRICT', 'BALANCED', 'FLEXIBLE'] as const;
export const flexibilityLevelSchema = z.enum(FLEXIBILITY_LEVELS);
export type FlexibilityLevel = z.infer<typeof flexibilityLevelSchema>;
