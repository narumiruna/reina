import { z } from "zod"
import type { Config } from "../types.js"
import { eligible } from "./policy.js"
import { triageSchema } from "./schema.js"

export const ASSESSMENT_PROTOCOL_REVISION = "reina-issue-triage-1"

export const assessmentSchema = z
  .strictObject({
    kind: z.enum(["bug", "feature", "question", "documentation", "maintenance", "unknown"]),
    summary: z.string().trim().min(1).max(1_000),
    missingInfo: z.array(z.string().trim().min(1).max(300)).max(5),
    fix: triageSchema,
  })
  .superRefine((assessment, context) => {
    if (
      assessment.fix.eligible &&
      (assessment.missingInfo.length > 0 ||
        ["feature", "question", "unknown"].includes(assessment.kind) ||
        assessment.fix.category === "defer" ||
        assessment.fix.risks.length > 0 ||
        assessment.fix.requiresHumanDecision)
    ) {
      context.addIssue({
        code: "custom",
        path: ["fix", "eligible"],
        message: "Contradictory eligibility assessment",
      })
    }
  })

export type Assessment = z.infer<typeof assessmentSchema>
export type TriageOutcome = "fix_candidate" | "needs_info" | "needs_human"

export function assessmentOutcome(assessment: Assessment, config: Config): TriageOutcome {
  if (assessment.fix.risks.length > 0 || assessment.fix.requiresHumanDecision) return "needs_human"
  if (assessment.missingInfo.length > 0) return "needs_info"
  if (
    !["feature", "question", "unknown"].includes(assessment.kind) &&
    eligible(assessment.fix, config)
  )
    return "fix_candidate"
  return "needs_human"
}
