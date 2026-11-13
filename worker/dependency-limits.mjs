const MiB = 1024 * 1024

export const DEPENDENCY_TARBALL_BYTES = 64 * MiB
export const DEPENDENCY_DOWNLOAD_BYTES = 1024 * MiB
export const DEPENDENCY_EXPORT_FILE_BYTES = 128 * MiB
export const DEPENDENCY_EXPORT_BYTES = 512 * MiB
export const DEPENDENCY_ARCHIVE_BYTES = 576 * MiB
export const DEPENDENCY_IMPORT_WIRE_BYTES = 96 * MiB
export const PREPARATION_WORKSPACE_BYTES = 2048 * MiB

function assertSize(bytes, maximum, code) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum) throw new Error(code)
}

export function assertDependencyDownloadSize(bytes, total) {
  assertSize(bytes, DEPENDENCY_TARBALL_BYTES, "dependency_download_limit")
  assertSize(total, DEPENDENCY_DOWNLOAD_BYTES, "dependency_download_limit")
}

export function assertDependencyImportSize(bytes) {
  assertSize(bytes, DEPENDENCY_TARBALL_BYTES, "dependency_download_limit")
}

export function assertDependencyImportWireSize(bytes) {
  assertSize(bytes, DEPENDENCY_IMPORT_WIRE_BYTES, "dependency_download_limit")
}

export function assertDependencyExportSize(bytes, total) {
  assertSize(bytes, DEPENDENCY_EXPORT_FILE_BYTES, "dependency_export_limit")
  assertSize(total, DEPENDENCY_EXPORT_BYTES, "dependency_export_limit")
}

export function assertDependencyArchiveSize(bytes) {
  assertSize(bytes, DEPENDENCY_ARCHIVE_BYTES, "dependency_export_limit")
}
