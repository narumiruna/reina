import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const manifest = Buffer.from(
  JSON.stringify({
    name: "reina-runtime-fixture",
    version: "1.0.0",
    private: true,
    dependencies: { "is-number": "7.0.0" },
    scripts: {
      preinstall:
        "node -e \"require('node:fs').writeFileSync('/workspace/node_modules/lifecycle-ran','unsafe')\"",
    },
  }),
)
export const lock = Buffer.from(
  JSON.stringify({
    name: "reina-runtime-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "reina-runtime-fixture",
        version: "1.0.0",
        dependencies: { "is-number": "7.0.0" },
      },
      "node_modules/is-number": {
        version: "7.0.0",
        resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
        integrity:
          "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
        engines: { node: ">=0.12.0" },
      },
    },
  }),
)
export const baseline = {
  branch: "main",
  sha: "1".repeat(40),
  files: {
    "package.json": { mode: "100644", content: manifest },
    "package-lock.json": { mode: "100644", content: lock },
    "src/message.txt": { mode: "100644", content: Buffer.from("before\n") },
  },
}

export const fixtureTag = (name) => `reina-${name}-fixture:${randomUUID()}`

export async function prepareFixture(tag) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reina-approved-fixture-"))
  try {
    await writeFile(path.join(directory, "package.json"), manifest)
    await writeFile(path.join(directory, "package-lock.json"), lock)
    const child = spawn(process.execPath, ["scripts/prepare-worker.mjs", directory, tag], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    let error = ""
    child.stdout.on("data", (chunk) => {
      output += chunk
    })
    child.stderr.on("data", (chunk) => {
      error += chunk
    })
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    if (code !== 0) throw new Error(`Fixture image preparation failed (${code}): ${error}`)
    const image = output.trim()
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Fixture image ID missing")
    return image
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
