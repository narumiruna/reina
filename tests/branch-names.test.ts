import { describe, expect, test } from "vitest"
import { branchFor } from "../src/github/scanner.js"

describe("branchFor", () => {
  test("returns the issue branch name", () => {
    expect(branchFor(23)).toBe("narumi/fix/reina-issue-23")
  })

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NEGATIVE_INFINITY,
    Number.MIN_SAFE_INTEGER - 1,
  ])("rejects invalid issue number %s", (number) => {
    expect(() => branchFor(number)).toThrow()
  })
})
