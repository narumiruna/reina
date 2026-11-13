import { describe, expect, test } from "vitest"
import {
  assertDependencyArchiveSize,
  assertDependencyDownloadSize,
  assertDependencyExportSize,
  assertDependencyImportSize,
  assertDependencyImportWireSize,
  DEPENDENCY_ARCHIVE_BYTES,
  DEPENDENCY_DOWNLOAD_BYTES,
  DEPENDENCY_EXPORT_BYTES,
  DEPENDENCY_EXPORT_FILE_BYTES,
  DEPENDENCY_IMPORT_WIRE_BYTES,
  DEPENDENCY_TARBALL_BYTES,
  PREPARATION_WORKSPACE_BYTES,
} from "../worker/dependency-limits.mjs"

const MiB = 1024 * 1024

test("dependency preparation uses fixed byte limits", () => {
  expect([
    DEPENDENCY_TARBALL_BYTES,
    DEPENDENCY_DOWNLOAD_BYTES,
    DEPENDENCY_EXPORT_FILE_BYTES,
    DEPENDENCY_EXPORT_BYTES,
    DEPENDENCY_ARCHIVE_BYTES,
    DEPENDENCY_IMPORT_WIRE_BYTES,
    PREPARATION_WORKSPACE_BYTES,
  ]).toEqual([64, 1024, 128, 512, 576, 96, 2048].map((size) => size * MiB))
})

const bounds = [
  {
    name: "individual dependency download",
    maximum: 64 * MiB,
    code: "dependency_download_limit",
    check: (bytes: number) => assertDependencyDownloadSize(bytes, 1024 * MiB),
  },
  {
    name: "cumulative dependency downloads",
    maximum: 1024 * MiB,
    code: "dependency_download_limit",
    check: (bytes: number) => assertDependencyDownloadSize(0, bytes),
  },
  {
    name: "decoded dependency import",
    maximum: 64 * MiB,
    code: "dependency_download_limit",
    check: assertDependencyImportSize,
  },
  {
    name: "dependency import JSON wire",
    maximum: 96 * MiB,
    code: "dependency_download_limit",
    check: assertDependencyImportWireSize,
  },
  {
    name: "individual exported dependency file",
    maximum: 128 * MiB,
    code: "dependency_export_limit",
    check: (bytes: number) => assertDependencyExportSize(bytes, 512 * MiB),
  },
  {
    name: "cumulative exported dependency files",
    maximum: 512 * MiB,
    code: "dependency_export_limit",
    check: (bytes: number) => assertDependencyExportSize(0, bytes),
  },
  {
    name: "raw Docker dependency archive",
    maximum: 576 * MiB,
    code: "dependency_export_limit",
    check: assertDependencyArchiveSize,
  },
]

describe.each(bounds)("$name", ({ maximum, code, check }) => {
  test("accepts zero and the exact maximum", () => {
    expect(() => check(0)).not.toThrow()
    expect(() => check(maximum)).not.toThrow()
  })

  test("rejects one byte above the maximum", () => {
    expect(() => check(maximum + 1)).toThrow(new Error(code))
  })

  test.each([-1, -0.5, 0.5, NaN, -Infinity, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid byte count %s",
    (bytes) => {
      expect(() => check(bytes)).toThrow(new Error(code))
    },
  )
})

test("downloads accumulate across tarballs without allocating their contents", () => {
  let total = 0
  for (let file = 0; file < 16; file++) {
    total += 64 * MiB
    expect(() => assertDependencyDownloadSize(64 * MiB, total)).not.toThrow()
  }
  expect(() => assertDependencyDownloadSize(1, total + 1)).toThrow("dependency_download_limit")
})

test("exports accumulate across files without allocating their contents", () => {
  let total = 0
  for (let file = 0; file < 4; file++) {
    total += 128 * MiB
    expect(() => assertDependencyExportSize(128 * MiB, total)).not.toThrow()
  }
  expect(() => assertDependencyExportSize(1, total + 1)).toThrow("dependency_export_limit")
})

test("a maximum tarball fits the dependency import JSON wire limit", () => {
  const envelope = JSON.stringify([{ path: "dependency.tgz", mode: "100644", content: "" }])
  const wireBytes = Buffer.byteLength(envelope) + 4 * Math.ceil((64 * MiB) / 3)
  expect(wireBytes).toBeGreaterThan(48 * MiB)
  expect(() => assertDependencyImportWireSize(wireBytes)).not.toThrow()
})
