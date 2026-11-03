import { Readable } from "node:stream"
import tar from "tar-stream"
import { safePath } from "../triage/policy.js"
import type { Snapshot, SourceFile } from "../types.js"

const MAX_FILES = 2000
const MAX_BYTES = 16 * 1024 * 1024
const MAX_FILE = 1024 * 1024
export const ARCHIVE_LIMIT = 24 * 1024 * 1024

export function checkSnapshot(snapshot: Snapshot): void {
  let total = 0
  const names = Object.keys(snapshot.files)
  if (names.length > MAX_FILES) throw new Error("snapshot_file_limit")
  for (const name of names) {
    const file = snapshot.files[name]
    if (
      !safePath(name) ||
      name === "node_modules" ||
      name.startsWith("node_modules/") ||
      name.length > 240
    )
      throw new Error("snapshot_unsafe_path")
    if (!["100644", "100755"].includes(file.mode) || !Buffer.isBuffer(file.content))
      throw new Error("snapshot_nonregular_file")
    total += file.content.length
    if (file.content.length > MAX_FILE || total > MAX_BYTES) throw new Error("snapshot_size_limit")
    for (let at = name.indexOf("/"); at >= 0; at = name.indexOf("/", at + 1)) {
      if (Object.hasOwn(snapshot.files, name.slice(0, at)))
        throw new Error("snapshot_path_conflict")
    }
  }
}

export async function createArchive(files: Record<string, SourceFile>): Promise<Buffer> {
  checkSnapshot({ files, sha: "", branch: "" })
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const collected = (async () => {
    for await (const chunk of pack) {
      if (!Buffer.isBuffer(chunk)) throw new Error("archive_invalid_chunk")
      chunks.push(Buffer.from(chunk))
    }
  })()
  const directories = new Set<string>()
  for (const name of Object.keys(files).sort()) {
    const segments = name.split("/")
    for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join("/"))
  }
  for (const name of [...directories].sort())
    pack.entry({ name, type: "directory", mode: 0o755, uid: 1000, gid: 1000 })
  for (const name of Object.keys(files).sort()) {
    const file = files[name]
    pack.entry(
      {
        name,
        type: "file",
        mode: file.mode === "100755" ? 0o755 : 0o644,
        uid: 1000,
        gid: 1000,
        size: file.content.length,
      },
      file.content,
    )
  }
  pack.finalize()
  await collected
  return Buffer.concat(chunks)
}

/** Parse daemon output into external buffers. Never extract agent-controlled paths on the host. */
export async function parseWorkspaceArchive(
  bytes: Buffer,
  dependencies = true,
): Promise<Record<string, SourceFile>> {
  if (bytes.length > ARCHIVE_LIMIT) throw new Error("artifact_archive_limit")
  const extract = tar.extract()
  const files: Record<string, SourceFile> = Object.create(null)
  const seen = new Set<string>()
  let total = 0
  let entries = 0
  const completed = new Promise<void>((resolve, reject) => {
    extract.once("finish", resolve)
    extract.once("error", reject)
    extract.on("entry", (header, stream, next) => {
      void (async () => {
        let name = header.name.replace(/^\.\//, "")
        if (header.type === "directory") name = name.replace(/\/$/, "")
        if (++entries > 4001) throw new Error("artifact_entry_limit")
        if (name === "." || name === "") {
          if (header.type !== "directory") throw new Error("artifact_unsafe_path")
          stream.resume()
          next()
          return
        }
        if (!safePath(name) || name.length > 240 || seen.has(name))
          throw new Error("artifact_unsafe_path")
        seen.add(name)
        if (name === "node_modules") {
          if (
            !dependencies ||
            header.type !== "symlink" ||
            header.linkname !== "/opt/deps/node_modules"
          )
            throw new Error("artifact_dependencies_changed")
          stream.resume()
          next()
          return
        }
        if (name.startsWith("node_modules/")) throw new Error("artifact_dependencies_changed")
        if (header.type === "directory") {
          stream.resume()
          next()
          return
        }
        if (header.type !== "file") throw new Error("artifact_nonregular_file")
        if (
          Object.keys(files).length >= MAX_FILES ||
          header.size === undefined ||
          header.size > MAX_FILE ||
          header.size < 0 ||
          total + header.size > MAX_BYTES
        )
          throw new Error("artifact_size_limit")
        if (header.mode !== 0o644 && header.mode !== 0o755) throw new Error("artifact_file_mode")
        const chunks: Buffer[] = []
        let length = 0
        for await (const chunk of stream) {
          if (!Buffer.isBuffer(chunk)) throw new Error("archive_invalid_chunk")
          length += chunk.length
          if (length > header.size) throw new Error("artifact_size_mismatch")
          chunks.push(Buffer.from(chunk))
        }
        if (length !== header.size) throw new Error("artifact_size_mismatch")
        total += length
        files[name] = {
          content: Buffer.concat(chunks),
          mode: header.mode === 0o755 ? "100755" : "100644",
        }
        next()
      })().catch((error) => {
        stream.resume()
        extract.destroy(error instanceof Error ? error : new Error("artifact_invalid_tar"))
      })
    })
  })
  Readable.from([bytes]).pipe(extract)
  await completed
  return files
}
