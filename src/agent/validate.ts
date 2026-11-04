import { createHash } from "node:crypto"
import { TextDecoder } from "node:util"
import { createTwoFilesPatch } from "diff"
import { allowedPath, safePath } from "../triage/policy.js"
import type { Artifact, Config, Proposal, Snapshot, SourceFile } from "../types.js"
import { checkSnapshot } from "./archive.js"

function text(bytes: Buffer): string {
  if (bytes.includes(0)) throw new Error("artifact_binary_change")
  let value: string
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error("artifact_binary_change")
  }
  if (
    !Buffer.from(value).equals(bytes) ||
    bytes.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)
  )
    throw new Error("artifact_binary_change")
  return value
}

/** Include verification after trusted checks. No caller-owned Buffer becomes artifact storage. */
export function artifactHash(artifact: Pick<Artifact, "files" | "diff" | "verification">): string {
  const hash = createHash("sha256")
  for (const file of [...artifact.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    const bytes = file.content === null ? null : Buffer.from(file.content, "base64")
    if (bytes && bytes.toString("base64") !== file.content)
      throw new Error("artifact_invalid_encoding")
    hash.update(JSON.stringify([file.path, file.mode, bytes?.length ?? null]))
    if (bytes) hash.update(bytes)
  }
  hash.update(JSON.stringify([artifact.diff, artifact.verification]))
  return hash.digest("hex")
}

export function validateArtifact(
  base: Snapshot,
  resultFiles: Record<string, SourceFile>,
  proposal: Proposal,
  config: Config,
): Artifact {
  checkSnapshot(base)
  checkSnapshot({ ...base, files: resultFiles })
  if (
    base.sha !== proposal.baseSha ||
    base.branch !== proposal.baseBranch ||
    proposal.image !== config.image
  )
    throw new Error("artifact_base_mismatch")
  const approved = new Set(proposal.decision.affectedFiles)
  if (
    !approved.size ||
    approved.size !== proposal.decision.affectedFiles.length ||
    [...approved].some((path) => !safePath(path) || !allowedPath(path, config))
  )
    throw new Error("artifact_invalid_scope")
  const artifact: Artifact = { files: [], diff: "", hash: "", verification: [] }
  for (const path of [
    ...new Set([...Object.keys(base.files), ...Object.keys(resultFiles)]),
  ].sort()) {
    if (!safePath(path)) throw new Error("artifact_unsafe_path")
    const old = Object.hasOwn(base.files, path) ? base.files[path] : undefined
    const next = Object.hasOwn(resultFiles, path) ? resultFiles[path] : undefined
    if ((old && !Buffer.isBuffer(old.content)) || (next && !Buffer.isBuffer(next.content)))
      throw new Error("artifact_nonregular_file")
    if (
      (old && !["100644", "100755"].includes(old.mode)) ||
      (next && !["100644", "100755"].includes(next.mode))
    )
      throw new Error("artifact_file_mode")
    if (old && next && old.mode !== next.mode) throw new Error("artifact_file_mode")
    if (old && next && old.content.equals(next.content)) continue
    if (!approved.has(path) || !allowedPath(path, config)) throw new Error("artifact_outside_scope")
    if (!old && next?.mode !== "100644") throw new Error("artifact_file_mode")
    const before = old ? text(old.content) : ""
    const after = next ? text(next.content) : ""
    artifact.files.push({
      path,
      content: next ? next.content.toString("base64") : null,
      mode: next?.mode ?? old?.mode ?? "100644",
    })
    if (artifact.files.length > Math.min(10, config.maxChangedFiles))
      throw new Error("artifact_file_limit")
    artifact.diff += createTwoFilesPatch(
      old ? `a/${path}` : "/dev/null",
      next ? `b/${path}` : "/dev/null",
      before,
      after,
      "",
      "",
      { context: 3 },
    )
    if (Buffer.byteLength(artifact.diff) > Math.min(64 * 1024, config.maxPatchBytes))
      throw new Error("artifact_diff_limit")
  }
  if (!artifact.files.length) throw new Error("artifact_no_changes")
  artifact.hash = artifactHash(artifact)
  return artifact
}
