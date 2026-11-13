import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { assertDependencyImportSize, assertDependencyImportWireSize } from "./dependency-limits.mjs"

// Called only before Pi or repository commands start. Input comes from the trusted host.
const kind = process.argv[2]
if (!["workspace", "config", "dependency"].includes(kind)) process.exit(1)
const chunks = []
let bytes = 0
for await (const chunk of process.stdin) {
  bytes += chunk.length
  if (kind === "dependency") assertDependencyImportWireSize(bytes)
  else if (bytes > 48 * 1024 * 1024) process.exit(1)
  chunks.push(chunk)
}
const files = JSON.parse(Buffer.concat(chunks))
if (!Array.isArray(files) || files.length > 2000) process.exit(1)
const root = kind === "config" ? "/tmp/reina-agent" : "/workspace"
let total = 0
for (const file of files) {
  if (
    typeof file.path !== "string" ||
    file.path.length > 512 ||
    /[\\:\p{Cc}\p{Cf}]/u.test(file.path) ||
    file.path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part === "node_modules")
  )
    process.exit(1)
  if (kind === "config" && !["settings.json", "models.json"].includes(file.path)) process.exit(1)
  if (kind === "dependency" && file.path !== "dependency.tgz") process.exit(1)
  if (!["100644", "100755"].includes(file.mode) || typeof file.content !== "string") process.exit(1)
  const data = Buffer.from(file.content, "base64")
  total += data.length
  if (kind === "dependency") assertDependencyImportSize(total)
  else if (total > 16 * 1024 * 1024 || data.length > 1024 * 1024) process.exit(1)
  const destination = path.join(root, file.path)
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 })
  await writeFile(destination, data, { flag: "wx", mode: file.mode === "100755" ? 0o755 : 0o644 })
}
