import { createHash } from "node:crypto"
import tar from "tar-stream"
import { describe, expect, it } from "vitest"
import { createArchive, parseWorkspaceArchive } from "../src/agent/archive.js"
import {
  PI_VERSION,
  PiStream,
  piArguments,
  RECORD_LIMIT,
  STDERR_LIMIT,
  STREAM_LIMIT,
  trustedModels,
  trustedSettings,
} from "../src/agent/pi.js"
import { containerArguments, imageMatchesReference } from "../src/agent/sandbox.js"
import { artifactHash, validateArtifact } from "../src/agent/validate.js"
import type { Config, Proposal, Snapshot, SourceFile } from "../src/types.js"

const config = {
  repository: { owner: "example", name: "example", id: 1, installationId: 1 },
  image: `sha256:${"1".repeat(64)}`,
  allowedPaths: ["README.md", "docs/**", "src/**", "tests/**"],
  forbiddenPaths: ["src/private/**"],
  maxChangedFiles: 10,
  maxPatchBytes: 65536,
} as Config
const base: Snapshot = {
  branch: "main",
  sha: "a".repeat(40),
  files: { "src/a.txt": { mode: "100644", content: Buffer.from("old\n") } },
}
const proposal = {
  baseSha: base.sha,
  baseBranch: base.branch,
  image: config.image,
  decision: { affectedFiles: ["src/a.txt", "docs/new.md"] },
} as Proposal
const regular = (text: string): SourceFile => ({ mode: "100644", content: Buffer.from(text) })

function events(text = "done", stopReason = "stop", settled = true): Buffer {
  return Buffer.from(
    `${[
      { type: "session", version: 3 },
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
      },
      { type: "agent_end", messages: [] },
      ...(settled ? [{ type: "agent_settled", aborted: false }] : []),
    ]
      .map((value) => JSON.stringify(value))
      .join("\n")}\n`,
  )
}

async function tarBytes(
  header: Partial<tar.Header> & { name: string },
  content = Buffer.alloc(0),
): Promise<Buffer> {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const done = (async () => {
    for await (const chunk of pack) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk)
    }
  })()
  pack.entry(header, content)
  pack.finalize()
  await done
  return Buffer.concat(chunks)
}

describe("Pi 1.5.0 CLI boundary", () => {
  it("selects only documented flags, exact custom model and phase tools", () => {
    expect(PI_VERSION).toBe("1.5.0")
    const argv = piArguments("fixture", "triage")
    for (const flag of [
      "--print",
      "--no-session",
      "--no-approve",
      "--offline",
      "--no-context-files",
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    ])
      expect(argv).toContain(flag)
    expect(argv[argv.indexOf("--model") + 1]).toBe("reina/fixture")
    expect(argv[argv.indexOf("--tools") + 1]).toBe("read,grep,find,ls")
    expect(piArguments("fixture", "code").join(" ")).toContain("read,grep,find,ls,bash,edit,write")
    expect(() => piArguments("fixture:high", "code")).toThrow()
    expect(JSON.stringify(trustedSettings())).toContain('"maxRetries":0')
    expect(JSON.stringify(trustedModels("fixture", "a".repeat(64)))).toContain("127.0.0.1:3210/v1")
    expect(
      JSON.stringify(
        trustedModels("fixture", "a".repeat(64), { contextWindow: 64000, maxTokens: 2048 }),
      ),
    ).toContain('"maxTokens":2048')
    expect(() => trustedModels("fixture", "a".repeat(64), { maxTokens: 4097 })).toThrow(
      "invalid_model_limits",
    )
  })

  it("handles split UTF-8 and Unicode separators without changing LF framing", () => {
    const parser = new PiStream()
    const bytes = events("one\u2028two\u2029日本語")
    for (const byte of bytes) parser.stdout(Buffer.from([byte]))
    expect(parser.finish(0)).toBe("one\u2028two\u2029日本語")
  })

  it.each(["error", "aborted", "length", "pending", "toolUse"])(
    "rejects %s even on process exit 0",
    (stopReason) => {
      const parser = new PiStream()
      expect(() => {
        parser.stdout(events("partial", stopReason))
        parser.finish(0)
      }).toThrow()
    },
  )

  it("requires settlement, non-abort, successful exit and LF termination", () => {
    for (const bytes of [
      events("done", "stop", false),
      events().subarray(0, -1),
      Buffer.from('{"type":"session"}\n{"type":"agent_settled","aborted":true}\n'),
    ]) {
      const parser = new PiStream()
      expect(() => {
        parser.stdout(bytes)
        parser.finish(0)
      }).toThrow()
    }
    const parser = new PiStream()
    parser.stdout(events())
    expect(() => parser.finish(1)).toThrow("pi_exit_failure")
    expect(() => parser.stdout(Buffer.from('{"type":"agent_start"}\n'))).toThrow("after_settlement")
  })

  it("bounds both streams and rejects malformed data without disclosing it", () => {
    expect(() => new PiStream().stdout(Buffer.alloc(RECORD_LIMIT + 1, 32))).toThrow(
      "pi_record_limit",
    )
    expect(() => new PiStream().stderr(Buffer.alloc(STDERR_LIMIT + 1))).toThrow("pi_stderr_limit")
    expect(() => new PiStream().stdout(Buffer.alloc(STREAM_LIMIT + 1))).toThrow("pi_stdout_limit")
    expect(() => new PiStream().stdout(Buffer.from("secret-not-json\n"))).toThrow(
      "pi_malformed_json",
    )
  })

  it("resolves only the approved cached image ID or repository digest", () => {
    const digest = `sha256:${"a".repeat(64)}`
    const image = {
      Id: config.image,
      RepoDigests: [`node@${digest}`, `example.test:5000/worker@${digest}`],
    }
    expect(imageMatchesReference(config.image, image)).toBe(true)
    expect(imageMatchesReference(`node:26@${digest}`, image)).toBe(true)
    expect(imageMatchesReference(`docker.io/library/node@${digest}`, image)).toBe(true)
    expect(imageMatchesReference(`example.test:5000/worker:tag@${digest}`, image)).toBe(true)
    expect(imageMatchesReference(`other@${digest}`, image)).toBe(false)
    expect(imageMatchesReference(`node@sha256:${"b".repeat(64)}`, image)).toBe(false)
    expect(imageMatchesReference("node:26", image)).toBe(false)
  })

  it("never requests host networking or credential mounts", () => {
    const argv = containerArguments(config.image, "job", "owner", "code", "/tmp/job/model.sock")
    for (const flag of [
      "--network=none",
      "--read-only",
      "--user=1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--cpus=1",
      "--memory=2g",
      "--pids-limit=128",
    ])
      expect(argv).toContain(flag)
    expect(argv.join(" ")).not.toContain("network=host")
    expect(argv.join(" ")).not.toContain("docker.sock")
    expect(argv.join(" ")).toContain("job-workspace")
  })
})

describe("frozen archive boundary", () => {
  it("round trips bytes and file modes without extracting onto the host", async () => {
    const files = {
      "src/a.txt": regular("one\n"),
      "docs/nested/n.txt": { mode: "100755" as const, content: Buffer.from("two\n") },
    }
    expect(await parseWorkspaceArchive(await createArchive(files), false)).toEqual(files)
  })

  it.each([
    { name: "../outside", type: "file" as const },
    { name: "/absolute", type: "file" as const },
    { name: "src/link", type: "symlink" as const, linkname: "/etc/passwd" },
    { name: "src/hard", type: "link" as const, linkname: "src/a" },
    { name: "src/fifo", type: "fifo" as const },
    { name: "src/suid", type: "file" as const, mode: 0o4644 },
  ])("rejects unsafe entry $name", async (header) => {
    await expect(parseWorkspaceArchive(await tarBytes(header), false)).rejects.toThrow()
  })

  it("accepts only the fixed immutable dependency link", async () => {
    expect(
      await parseWorkspaceArchive(
        await tarBytes({
          name: "node_modules",
          type: "symlink",
          linkname: "/opt/deps/node_modules",
        }),
      ),
    ).toEqual({})
    await expect(
      parseWorkspaceArchive(
        await tarBytes({ name: "node_modules", type: "symlink", linkname: "/etc" }),
      ),
    ).rejects.toThrow()
    await expect(
      parseWorkspaceArchive(
        await tarBytes({ name: "src/huge", mode: 0o644, size: 1048577 }, Buffer.alloc(1048577)),
      ),
    ).rejects.toThrow()
  })
})

describe("artifact policy", () => {
  it("produces an exact base64 patch, hashes final bytes and includes verification", () => {
    const content = Buffer.from("new 日本語\n")
    const artifact = validateArtifact(
      base,
      { "src/a.txt": { mode: "100644", content } },
      proposal,
      config,
    )
    expect(artifact.files).toEqual([
      { path: "src/a.txt", mode: "100644", content: content.toString("base64") },
    ])
    expect(artifact.diff).toContain("-old\n+new 日本語")
    const hash = artifact.hash
    content.fill(0)
    expect(artifactHash(artifact)).toBe(hash)
    artifact.verification = [
      { argv: ["node", "--test"], exitCode: 0, durationMs: 10, image: config.image },
    ]
    expect(artifactHash(artifact)).not.toBe(hash)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("supports regular additions and deletions", () => {
    const artifact = validateArtifact(base, { "docs/new.md": regular("added\n") }, proposal, config)
    expect(artifact.files).toContainEqual({ path: "src/a.txt", mode: "100644", content: null })
    expect(artifact.files).toContainEqual({
      path: "docs/new.md",
      mode: "100644",
      content: Buffer.from("added\n").toString("base64"),
    })
  })

  it("rejects no-op, scope, forbidden, mode, binary and size changes", () => {
    expect(() => validateArtifact(base, base.files, proposal, config)).toThrow("no_changes")
    expect(() =>
      validateArtifact(base, { ...base.files, "src/other": regular("new") }, proposal, config),
    ).toThrow("outside_scope")
    expect(() =>
      validateArtifact(
        base,
        { "src/a.txt": { ...regular("new"), mode: "100755" } },
        proposal,
        config,
      ),
    ).toThrow("file_mode")
    for (const bytes of [Buffer.from([0]), Buffer.from([0xff]), Buffer.from([1])])
      expect(() =>
        validateArtifact(
          base,
          { "src/a.txt": { mode: "100644", content: bytes } },
          proposal,
          config,
        ),
      ).toThrow("binary_change")
    expect(() =>
      validateArtifact(base, { "src/a.txt": regular("x".repeat(70000)) }, proposal, config),
    ).toThrow("diff_limit")
    for (const name of [
      "package.json",
      ".pi/settings.json",
      "src/private/a",
      "src/AGENTS.md",
      "tests/x.key",
    ]) {
      const scope = { ...proposal, decision: { ...proposal.decision, affectedFiles: [name] } }
      expect(() =>
        validateArtifact(base, { ...base.files, [name]: regular("new") }, scope, config),
      ).toThrow()
    }
  })

  it("uses a deterministic byte-level digest", () => {
    const artifact = {
      files: [{ path: "src/a.txt", mode: "100644" as const, content: "bmV3Cg==" }],
      diff: "diff",
      verification: [],
    }
    const expected = createHash("sha256")
      .update(JSON.stringify(["src/a.txt", "100644", 4]))
      .update(Buffer.from("new\n"))
      .update(JSON.stringify(["diff", []]))
      .digest("hex")
    expect(artifactHash(artifact)).toBe(expected)
    expect(() =>
      artifactHash({ ...artifact, files: [{ ...artifact.files[0], content: "not base64" }] }),
    ).toThrow("invalid_encoding")
  })
})
