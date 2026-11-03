import { z } from "zod"

const text = (max: number) => z.string().trim().min(1).max(max)

export const triageSchema = z
  .strictObject({
    eligible: z.boolean(),
    category: z.enum([
      "documentation",
      "typo",
      "bug",
      "tests",
      "behavior",
      "error-handling",
      "defer",
    ]),
    reason: text(2_000),
    proposedFix: z.string().trim().max(4_000),
    affectedFiles: z
      .array(z.string().min(1).max(512))
      .max(10)
      .refine((paths) => new Set(paths).size === paths.length, "Duplicate file paths"),
    verificationPlan: z.array(text(1_000)).max(10),
    requiresHumanDecision: z.boolean(),
    risks: z.array(text(1_000)).max(10),
  })
  .superRefine((decision, context) => {
    if (!decision.eligible) return
    for (const field of ["proposedFix", "affectedFiles", "verificationPlan"] as const) {
      if (decision[field].length === 0) {
        context.addIssue({ code: "custom", path: [field], message: "Missing eligibility evidence" })
      }
    }
  })
