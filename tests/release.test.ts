import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
const configuration = JSON.parse(readFileSync(new URL("../biome.json", import.meta.url), "utf8"))
const biome = fileURLToPath(new URL("../node_modules/.bin/biome", import.meta.url))
const generated = "# reina\n\n## 0.2.0\n\n- fixture: First paragraph.\n  \n  Second paragraph.\n"
const directories: string[] = []

function fixture(failVersion = false) {
  const directory = mkdtempSync(join(tmpdir(), "reina-release-format-"))
  directories.push(directory)
  const bin = join(directory, "node_modules", ".bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "release-format-fixture",
      version: "0.1.1",
      private: true,
      scripts: { "version-packages": manifest.scripts["version-packages"] },
    }),
  )
  writeFileSync(
    join(directory, "biome.json"),
    JSON.stringify({ ...configuration, vcs: { ...configuration.vcs, enabled: false } }),
  )
  // The version stub reproduces Changesets' output without Git, credentials, or publishing.
  writeFileSync(
    join(bin, "changeset"),
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] !== "version") process.exit(3);
if (${failVersion}) process.exit(2);
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
manifest.version = "0.2.0";
fs.writeFileSync("package.json", JSON.stringify(manifest));
fs.writeFileSync("CHANGELOG.md", ${JSON.stringify(generated)});
`,
    { mode: 0o755 },
  )
  symlinkSync(biome, join(bin, "biome"))
  const run = (command: string, args: string[]) =>
    spawnSync(command, args, {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        TMPDIR: directory,
        CI: "1",
      },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 128 * 1024,
    })
  return { directory, run }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("release changelog formatting", () => {
  it("wires the Changesets action to the tested version command", () => {
    expect(workflow).toMatch(/^\s+version-script: npm run version-packages\s*$/m)
    expect(typeof manifest.scripts["version-packages"]).toBe("string")
  })

  it("formats generated multiline notes without changing unrelated files or disabling CI", () => {
    const { directory, run } = fixture()
    writeFileSync(join(directory, "README.md"), generated)
    const result = run("npm", ["run", "version-packages"])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version).toBe("0.2.0")
    expect(readFileSync(join(directory, "CHANGELOG.md"), "utf8")).toBe(
      generated.replace(/^ +$/gm, ""),
    )
    expect(readFileSync(join(directory, "README.md"), "utf8")).toBe(generated)
    const check = run(biome, ["ci", "CHANGELOG.md"])
    expect(check.status, check.stderr).toBe(0)
    const unrelated = run(biome, ["ci", "README.md"])
    expect(unrelated.status).not.toBe(0)
    expect(unrelated.stdout + unrelated.stderr).toContain("README.md")
  })

  it("does not format an existing changelog when version generation fails", () => {
    const { directory, run } = fixture(true)
    writeFileSync(join(directory, "CHANGELOG.md"), generated)
    const result = run("npm", ["run", "version-packages"])
    expect(result.status, result.stdout + result.stderr).toBe(2)
    expect(readFileSync(join(directory, "CHANGELOG.md"), "utf8")).toBe(generated)
    expect(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version).toBe("0.1.1")
  })
})
