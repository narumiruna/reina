import { z } from "zod"

/** Pocket ID's groups claim contains exact group Names, not display names or IDs. */
export const groupNamesSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value)),
  )
  .max(256)
  .transform((groups) => [...new Set(groups)])
