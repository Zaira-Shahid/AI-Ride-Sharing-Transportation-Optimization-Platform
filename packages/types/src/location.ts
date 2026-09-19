import { z } from 'zod';

export const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  formattedAddress: z.string().min(1),
  placeId: z.string().min(1),
});
export type Location = z.infer<typeof locationSchema>;
