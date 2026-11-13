import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { gzipSync } from "node:zlib"
import tar from "tar-stream"
import { ModelGateway } from "../../dist/agent/model-gateway.js"
import { containerArguments, DockerRuntime, dockerCommand } from "../../dist/agent/sandbox.js"
import { artifactHash, validateArtifact } from "../../dist/agent/validate.js"
import { baseline, fixtureTag, lock, manifest, prepareFixture } from "./fixture.mjs"
import { fakeModel } from "./model.mjs"

let model
let runtime
let config
let directory
let protocolImage
const controller = () => new AbortController()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function checked(argv, options) {
  const result = await dockerCommand(argv, options)
  assert.equal(result.exitCode, 0, `Docker ${argv[0]} failed`)
  return result
}
async function poll(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await check()
    if (value) return value
    await pause(50)
  }
  throw new Error("runtime_test_poll_timeout")
}
async function context(entries) {
  const pack = tar.pack()
  const chunks = []
  const collect = (async () => {
    for await (const chunk of pack) chunks.push(chunk)
  })()
  for (const [name, content] of entries)
    pack.entry({ name, size: content.length, mode: 0o644 }, content)
  pack.finalize()
  await collect
  return Buffer.concat(chunks)
}
const owned = () =>
  createHash("sha256")
    .update(`${config.stateDir}:${config.repository.id}`)
    .digest("hex")
    .slice(0, 24)
async function activeContainers() {
  return (await checked(["ps", "-aq", "--filter", `label=io.reina.owner=${owned()}`])).stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
}

before(
  async () => {
    const imageTag = fixtureTag("runtime")
    const image = await prepareFixture(imageTag)
    directory = await mkdtemp(path.join(os.tmpdir(), "reina-runtime-tests-"))
    model = await fakeModel()
    config = {
      repository: { owner: "fixture", name: "fixture", id: 77, installationId: 77 },
      stateDir: directory,
      image,
      model: "fixture",
      modelUrl: model.url,
      modelKey: "host-only-test-key",
      allowedPaths: ["src/**", "tests/**", "docs/**", "README.md"],
      forbiddenPaths: ["src/private/**"],
      commands: [
        [
          "node",
          "-e",
          "const fs=require('node:fs'),a=require('node:assert/strict');a.equal(fs.readFileSync('src/message.txt','utf8'),'after 日本語\\n');a.equal(require('is-number')(42),true);a.equal(fs.existsSync('node_modules/lifecycle-ran'),false);a.equal(fs.existsSync('/run/reina-model.sock'),false);a.equal(process.env.OPENAI_API_KEY,undefined);a.throws(()=>fs.writeFileSync('node_modules/forbidden','x'));fs.writeFileSync('src/message.txt','test mutation');",
        ],
      ],
      scanIntervalMs: 900000,
      maxIssuesPerScan: 10,
      maxConcurrentJobs: 1,
      agentTimeoutMs: 30000,
      maxChangedFiles: 10,
      maxPatchBytes: 65536,
    }
    runtime = new DockerRuntime(config)
    await runtime.preflight()
    const dockerfile = Buffer.from(
      `FROM ${imageTag}\nCOPY protocol-fixture.mjs /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js\n`,
    )
    const protocolTag = fixtureTag("protocol")
    await checked(["build", "--pull=false", "--network=none", "--tag", protocolTag, "-"], {
      input: await context([
        ["Dockerfile", dockerfile],
        ["protocol-fixture.mjs", await readFile("tests/runtime/protocol-fixture.mjs")],
      ]),
    })
    protocolImage = (await checked(["image", "inspect", "--format", "{{.Id}}", protocolTag])).stdout
      .toString()
      .trim()
  },
  { timeout: 290000 },
)

after(async () => {
  await runtime?.cleanup()
  await model?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

test("host Docker proxy configuration cannot inject credentials into a job", async () => {
  const original = process.env.DOCKER_CONFIG
  const client = await mkdtemp(path.join(os.tmpdir(), "reina-proxy-config-"))
  await writeFile(
    path.join(client, "config.json"),
    JSON.stringify({
      proxies: {
        default: {
          httpProxy: "http://fixture:fixture-password@192.0.2.1:3128",
          httpsProxy: "http://fixture:fixture-password@192.0.2.1:3128",
          allProxy: "http://fixture:fixture-password@192.0.2.1:3128",
          ftpProxy: "http://fixture:fixture-password@192.0.2.1:3128",
          noProxy: "sensitive-host.invalid",
        },
      },
    }),
  )
  const commands = [
    [
      "node",
      "-e",
      "for (const name of ['HTTP_PROXY','HTTPS_PROXY','FTP_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','ftp_proxy','all_proxy','no_proxy']) require('node:assert/strict').equal(process.env[name], '');",
    ],
  ]
  const isolated = new DockerRuntime({
    ...config,
    stateDir: path.join(directory, "proxy-runtime"),
    commands,
  })
  try {
    process.env.DOCKER_CONFIG = client
    await isolated.preflight()
    const result = await isolated.verify(baseline, commands, controller().signal)
    assert.equal(result[0].exitCode, 0)
  } finally {
    try {
      await isolated.cleanup()
    } finally {
      if (original === undefined) delete process.env.DOCKER_CONFIG
      else process.env.DOCKER_CONFIG = original
      await rm(client, { recursive: true, force: true })
    }
  }
})

test("restart cleanup removes only its private orphan staging directories", async () => {
  const orphan = await mkdtemp(path.join(os.tmpdir(), `reina-job-${owned()}-`))
  const unrelated = await mkdtemp(path.join(os.tmpdir(), "reina-job-unrelated-"))
  await writeFile(path.join(orphan, "snapshot.txt"), "private fixture source")
  await writeFile(path.join(unrelated, "keep.txt"), "unrelated fixture")
  try {
    await runtime.cleanup()
    await assert.rejects(readFile(path.join(orphan, "snapshot.txt")), { code: "ENOENT" })
    assert.equal(await readFile(path.join(unrelated, "keep.txt"), "utf8"), "unrelated fixture")
  } finally {
    await rm(orphan, { recursive: true, force: true })
    await rm(unrelated, { recursive: true, force: true })
  }
})

test("actual Pi 1.5.0 makes a tool call through only the mounted Unix gateway and freezes an artifact", {
  timeout: 60000,
}, async () => {
  const original = baseline.files["src/message.txt"].content.toString()
  const start = model.calls.length
  const result = await runtime.code(baseline, "CASE:CODE", controller().signal)
  assert.equal(result.finalText, "completed\u2028safely\u2029日本語")
  assert.equal(result.files["src/message.txt"].content.toString(), "after 日本語\n")
  assert.equal(baseline.files["src/message.txt"].content.toString(), original)
  const calls = model.calls.slice(start)
  assert.equal(calls.length, 2)
  assert.ok(
    calls[1].messages.some(
      (message) => message.role === "tool" && message.tool_call_id === "call_fixture",
    ),
  )
  const proposal = {
    baseSha: baseline.sha,
    baseBranch: baseline.branch,
    image: config.image,
    decision: { affectedFiles: ["src/message.txt"] },
  }
  const artifact = validateArtifact(baseline, result.files, proposal, config)
  const frozen = JSON.stringify(artifact)
  const candidate = {
    ...baseline,
    files: {
      ...baseline.files,
      "src/message.txt": {
        mode: "100644",
        content: Buffer.from(artifact.files[0].content, "base64"),
      },
    },
  }
  const records = await runtime.verify(candidate, config.commands, controller().signal)
  assert.equal(records.length, 1)
  assert.equal(records[0].exitCode, 0)
  assert.deepEqual(records[0].argv, config.commands[0])
  assert.equal(records[0].image, config.image)
  assert.ok(records[0].durationMs > 0)
  assert.equal(candidate.files["src/message.txt"].content.toString(), "after 日本語\n")
  assert.equal(JSON.stringify(artifact), frozen)
  artifact.verification = records
  assert.notEqual(artifactHash(artifact), artifact.hash)
  assert.deepEqual(await activeContainers(), [])
})

test("prepared images reject non-registry dependencies and wrong tarball integrity", {
  timeout: 60000,
}, async () => {
  for (const [reason, modify] of [
    [
      "dependency_registry_only",
      (entry) => {
        entry.resolved = "http://169.254.169.254/package.tgz"
      },
    ],
    [
      "dependency_integrity_failed",
      (entry) => {
        entry.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`
      },
    ],
  ]) {
    const source = await mkdtemp(path.join(directory, "rejected-lock-"))
    try {
      const altered = JSON.parse(lock)
      modify(altered.packages["node_modules/is-number"])
      await writeFile(path.join(source, "package.json"), manifest)
      await writeFile(path.join(source, "package-lock.json"), JSON.stringify(altered))
      const child = spawn(
        process.execPath,
        ["scripts/prepare-worker.mjs", source, fixtureTag("rejected")],
        { stdio: ["ignore", "ignore", "pipe"] },
      )
      let stderr = ""
      child.stderr.on("data", (chunk) => {
        stderr += chunk
        if (stderr.length > 262144) child.kill("SIGKILL")
      })
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      assert.equal(code, 1)
      assert.ok(stderr.trim().endsWith(reason))
      assert.equal(
        (await checked(["ps", "-aq", "--filter", "label=io.reina.preparation=true"])).stdout.length,
        0,
      )
      assert.equal(
        (await checked(["volume", "ls", "--quiet", "--filter", "label=io.reina.preparation=true"]))
          .stdout.length,
        0,
      )
    } finally {
      await rm(source, { recursive: true, force: true })
    }
  }
})

test("preparation stages dependency imports in the workspace with the original quotas", {
  timeout: 180000,
}, async (t) => {
  const name = `reina-import-fixture-${randomUUID()}`
  const volume = `${name}-workspace`
  const exec = (script) => checked(["exec", name, "node", "-e", script])
  const importFiles = (kind, files) =>
    dockerCommand(["exec", "--interactive", name, "node", "/opt/reina/import.mjs", kind], {
      input: Buffer.from(
        JSON.stringify(
          files.map(([file, content]) => ({
            path: file,
            mode: "100644",
            content: content.toString("base64"),
          })),
        ),
      ),
      timeoutMs: 60000,
    })
  const marker = "process.stdout.write(require('node:fs').readFileSync('/tmp/reina-ready'))"
  await checked([
    "volume",
    "create",
    "--driver=local",
    `--label=io.reina.owner=${owned()}`,
    "--label=io.reina.fixture=true",
    "--opt=type=tmpfs",
    "--opt=device=tmpfs",
    "--opt=o=size=2147483648,uid=1000,gid=1000,mode=0700,nosuid,nodev",
    volume,
  ])
  try {
    await checked(containerArguments(config.image, name, owned(), "prepare"))
    await checked(["start", name])
    await checked(["exec", name, "node", "/opt/reina/ready.mjs"])
    assert.equal(
      (await checked(["exec", name, "node", "/opt/reina/probe.mjs"])).stdout.toString(),
      "controls_verified\n",
    )
    const ready = (await exec(marker)).stdout
    assert.equal(ready.toString(), "ready")

    await t.test(
      "accepts exactly 64 MiB and rejects one more decoded byte without changing readiness",
      async () => {
        for (const size of [64 * 1024 * 1024, 64 * 1024 * 1024 + 1]) {
          const content = Buffer.alloc(size, 0x61)
          const digest = createHash("sha512").update(content).digest("hex")
          const errors = []
          // Send the actual JSON/base64 input to the worker, not just the size guards.
          const result = await dockerCommand(
            ["exec", "--interactive", name, "node", "/opt/reina/import.mjs", "dependency"],
            {
              input: Buffer.from(
                JSON.stringify([
                  { path: "dependency.tgz", mode: "100644", content: content.toString("base64") },
                ]),
              ),
              stderr: (chunk) => errors.push(chunk),
              timeoutMs: 60000,
            },
          )
          if (size === 64 * 1024 * 1024) {
            assert.equal(result.exitCode, 0, Buffer.concat(errors).toString())
            await exec(`const a=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
            a.equal(fs.statSync('/workspace/dependency.tgz').size,67108864);
            a.equal(crypto.createHash('sha512').update(fs.readFileSync('/workspace/dependency.tgz')).digest('hex'),${JSON.stringify(digest)});
            a.equal(fs.existsSync('/tmp/dependency.tgz'),false);
            fs.unlinkSync('/workspace/dependency.tgz');`)
          } else {
            assert.notEqual(result.exitCode, 0)
            assert.match(Buffer.concat(errors).toString(), /dependency_download_limit/)
            await exec(`const a=require('node:assert/strict'),fs=require('node:fs');
            a.equal(fs.existsSync('/workspace/dependency.tgz'),false);
            a.equal(fs.existsSync('/tmp/dependency.tgz'),false);`)
          }
          assert.deepEqual((await exec(marker)).stdout, ready)
        }
      },
    )

    await t.test(
      "caches a local package twice and installs offline with staging and cache cleanup",
      async () => {
        const packageName = "reina-local-cache-fixture"
        const lifecycle =
          "node -e \"require('node:fs').writeFileSync('/workspace/lifecycle-ran','unsafe')\""
        const content = gzipSync(
          await context([
            [
              "package/package.json",
              Buffer.from(
                JSON.stringify({
                  name: packageName,
                  version: "1.0.0",
                  main: "index.js",
                  scripts: { preinstall: lifecycle, install: lifecycle, postinstall: lifecycle },
                }),
              ),
            ],
            ["package/index.js", Buffer.from("module.exports = 'local-cache-fixture'\n")],
          ]),
        )
        const integrity = `sha512-${createHash("sha512").update(content).digest("base64")}`
        const packageManifest = {
          name: "reina-local-cache-consumer",
          version: "1.0.0",
          private: true,
          dependencies: { [packageName]: "1.0.0" },
          scripts: { preinstall: lifecycle, install: lifecycle, postinstall: lifecycle },
        }
        const packageLock = {
          name: packageManifest.name,
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": packageManifest,
            [`node_modules/${packageName}`]: {
              version: "1.0.0",
              resolved: `https://registry.npmjs.org/${packageName}/-/${packageName}-1.0.0.tgz`,
              integrity,
              hasInstallScript: true,
            },
          },
        }
        assert.equal(
          (
            await importFiles("workspace", [
              ["package.json", Buffer.from(JSON.stringify(packageManifest))],
              ["package-lock.json", Buffer.from(JSON.stringify(packageLock))],
            ])
          ).exitCode,
          0,
        )
        for (let attempt = 0; attempt < 2; attempt++) {
          assert.equal((await importFiles("dependency", [["dependency.tgz", content]])).exitCode, 0)
          await exec(`const a=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
          a.equal(fs.statSync('/workspace/dependency.tgz').size,${content.length});
          a.equal('sha512-'+crypto.createHash('sha512').update(fs.readFileSync('/workspace/dependency.tgz')).digest('base64'),${JSON.stringify(integrity)});`)
          await checked(["exec", name, "node", "/opt/reina/prepare.mjs", "cache"], {
            timeoutMs: 130000,
          })
          await exec(`const a=require('node:assert/strict'),fs=require('node:fs');
          a.equal(fs.existsSync('/workspace/dependency.tgz'),false);
          a.equal(fs.existsSync('/tmp/dependency.tgz'),false);
          a.equal(fs.existsSync('/workspace/.npm-cache/_cacache'),true);
          a.equal(fs.existsSync('/workspace/lifecycle-ran'),false);`)
          assert.deepEqual((await exec(marker)).stdout, ready)
        }
        await checked(["exec", name, "node", "/opt/reina/prepare.mjs", "install"], {
          timeoutMs: 130000,
        })
        await exec(`const a=require('node:assert/strict'),fs=require('node:fs');
        a.equal(require('/workspace/node_modules/${packageName}'),'local-cache-fixture');
        a.equal(fs.existsSync('/workspace/.npm-cache'),false);
        a.equal(fs.existsSync('/workspace/dependency.tgz'),false);
        a.equal(fs.existsSync('/tmp/dependency.tgz'),false);
        a.equal(fs.existsSync('/workspace/lifecycle-ran'),false);`)
        assert.deepEqual((await exec(marker)).stdout, ready)
      },
    )
  } finally {
    try {
      await checked(["rm", "--force", "--volumes", name])
    } finally {
      await checked(["volume", "rm", volume])
    }
  }
})

test("actual Pi triage uses read-only tools and returns one decision object", {
  timeout: 30000,
}, async () => {
  const start = model.calls.length
  const result = await runtime.triage(baseline, "CASE:TRIAGE", controller().signal)
  assert.equal(JSON.parse(result).fix.eligible, true)
  const calls = model.calls.slice(start)
  assert.equal(calls.length, 2)
  assert.deepEqual(
    calls[0].tools.map((tool) => tool.function.name),
    ["read", "grep", "find", "ls"],
  )
  assert.ok(calls[1].messages.some((message) => message.role === "tool"))
})

test("actual Pi zero-exit provider failure is rejected without retries", {
  timeout: 30000,
}, async () => {
  const start = model.calls.length
  await assert.rejects(runtime.code(baseline, "CASE:ERROR", controller().signal), /pi_agent_error/)
  assert.equal(model.calls.length - start, 1)
  assert.deepEqual(await activeContainers(), [])
})

test("triage exposes host-owned transient failures without retrying permanent provider errors", {
  timeout: 60000,
}, async () => {
  for (const [task, code] of [
    ["CASE:ERROR", "model_request_transient"],
    ["CASE:DENIED", "pi_agent_error"],
  ]) {
    const start = model.calls.length
    await assert.rejects(runtime.triage(baseline, task, controller().signal), { message: code })
    assert.equal(model.calls.length - start, 1)
    assert.deepEqual(await activeContainers(), [])
  }
})

async function hanging(phase, check) {
  const abort = controller()
  const initial = model.calls.length
  const pending = runtime[phase](baseline, "CASE:HANG", abort.signal)
  const settled = pending.then(
    () => null,
    (error) => error,
  )
  try {
    await poll(() => model.calls.length > initial)
    const ids = await activeContainers()
    assert.equal(ids.length, 1)
    await check(ids[0])
  } finally {
    abort.abort()
  }
  assert.match((await settled)?.message ?? "", /runtime_cancelled/)
  assert.deepEqual(await activeContainers(), [])
}

test("kernel netnone denies host TCP, metadata, DNS and IPv6; triage and root filesystems are read-only", {
  timeout: 60000,
}, async () => {
  const hostPath = path.join(directory, `host-only-${randomUUID()}`)
  await writeFile(hostPath, "not exposed")
  await hanging("triage", async (id) => {
    const [inspect] = JSON.parse((await checked(["inspect", id])).stdout.toString())
    const host = inspect.HostConfig
    assert.equal(host.NetworkMode, "none")
    assert.equal(host.ReadonlyRootfs, true)
    assert.equal(host.Privileged, false)
    assert.equal(host.Memory, 2147483648)
    assert.equal(host.MemorySwap, 2147483648)
    assert.equal(host.NanoCpus, 1000000000)
    assert.equal(host.PidsLimit, 128)
    assert.deepEqual(host.CapDrop, ["ALL"])
    assert.ok(host.SecurityOpt.includes("no-new-privileges:true"))
    const binds = inspect.Mounts.filter((mount) => mount.Type === "bind")
    assert.deepEqual(binds.map((mount) => mount.Destination).sort(), [
      "/run/reina-model.sock",
      "/workspace",
    ])
    assert.ok(binds.every((mount) => mount.RW === false))
    const script = `import a from 'node:assert/strict';import fs from 'node:fs/promises';import net from 'node:net';import dns from 'node:dns/promises';
      await a.rejects(fs.readFile(${JSON.stringify(hostPath)}));await a.rejects(fs.readFile('/var/run/docker.sock'));
      for(const file of ['/workspace/src/message.txt','/workspace/new','/root-write','/opt/reina/bridge.mjs']) await a.rejects(fs.writeFile(file,'blocked'),{code:'EROFS'});
      a.equal(process.env.OPENAI_API_KEY,undefined);a.equal(process.env.ANTHROPIC_API_KEY,undefined);
      a.equal((await fs.readFile('/tmp/reina-agent/models.json','utf8')).includes('host-only-test-key'),false);
      for(const host of ['127.0.0.1','host.docker.internal','169.254.169.254','1.1.1.1','::1','fd00:ec2::254']) await new Promise((resolve,reject)=>{const s=net.connect({host,port:${Number(new URL(model.url).port)}});s.setTimeout(500,()=>{s.destroy();resolve();});s.on('connect',()=>{s.destroy();reject(Error('network bypass'));});s.on('error',()=>resolve());});
      let resolved=false;await Promise.race([dns.resolve4('registry.npmjs.org').then(()=>{resolved=true;},()=>{}),new Promise(r=>setTimeout(r,1000))]);a.equal(resolved,false);process.stdout.write('denied');process.exit(0);`
    const proof = await checked(["exec", id, "node", "--input-type=module", "-e", script], {
      timeoutMs: 15000,
    })
    assert.equal(proof.stdout.toString(), "denied")
  })
})

test("workspace/temp quotas, seccomp, cgroup CPU and process limits are enforced", {
  timeout: 60000,
}, async () => {
  await hanging("code", async (id) => {
    assert.equal(
      (await checked(["exec", id, "node", "/opt/reina/probe.mjs"])).stdout.toString(),
      "controls_verified\n",
    )
    const wrongPhase = await dockerCommand([
      "exec",
      "--env=REINA_PHASE=prepare",
      id,
      "node",
      "/opt/reina/probe.mjs",
    ])
    assert.notEqual(wrongPhase.exitCode, 0)
    const script = `const a=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');
      for(const [dir,expected] of [['/workspace',268435456],['/tmp',67108864]]) {const stat=fs.statfsSync(dir);a.equal(stat.blocks*stat.bsize,expected);const file=dir+'/quota-test',fd=fs.openSync(file,'w');let full=false;try{const b=Buffer.alloc(4*1024*1024,1);for(let i=0;i<70;i++)fs.writeSync(fd,b);}catch(e){a.equal(e.code,'ENOSPC');full=true;}finally{fs.closeSync(fd);fs.unlinkSync(file);}a.equal(full,true);}
      (async()=>{const children=[];let denied=false;try{for(let i=0;i<140;i++){const child=cp.spawn('/bin/sleep',['20'],{stdio:'ignore'});const started=await new Promise(resolve=>{child.once('spawn',()=>resolve(true));child.once('error',e=>{a.equal(e.code,'EAGAIN');resolve(false);});});if(!started){denied=true;break;}children.push(child);}a.equal(denied,true);}finally{for(const child of children)child.kill('SIGKILL');await Promise.all(children.map(child=>new Promise(r=>child.once('close',r))));}
      const throttled=()=>Number(fs.readFileSync('/sys/fs/cgroup/cpu.stat','utf8').match(/nr_throttled (\\d+)/)[1]);const before=throttled();await Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{const p=cp.spawn(process.execPath,['-e','const end=Date.now()+1000;while(Date.now()<end){}'],{stdio:'ignore'});p.once('error',reject);p.once('close',code=>code===0?resolve():reject(Error('cpu probe failed')));})));a.ok(throttled()>before);process.stdout.write('limits_verified');})().catch(()=>process.exit(1));`
    const result = await checked(["exec", id, "node", "-e", script], { timeoutMs: 25000 })
    assert.equal(result.stdout.toString(), "limits_verified")
  })
})

test("offline verification records a real failure and rejects changed dependency identities", {
  timeout: 30000,
}, async () => {
  const commands = [["node", "-e", "process.exit(7)"]]
  const failed = new DockerRuntime({ ...config, commands })
  await failed.preflight()
  const records = await failed.verify(baseline, commands, controller().signal)
  assert.equal(records[0].exitCode, 7)
  await assert.rejects(
    failed.verify(baseline, [["node", "--version"]], controller().signal),
    /not_approved/,
  )
  const changed = {
    ...baseline,
    files: {
      ...baseline.files,
      "package-lock.json": { mode: "100644", content: Buffer.from("different") },
    },
  }
  await assert.rejects(
    failed.verify(changed, commands, controller().signal),
    /fingerprint_mismatch/,
  )
  await failed.cleanup()
})

test("protocol fixture rejects error, abort, missing settlement, malformed JSON and output overruns", {
  timeout: 90000,
}, async () => {
  const fixture = new DockerRuntime({ ...config, image: protocolImage, agentTimeoutMs: 10000 })
  await fixture.preflight()
  for (const task of [
    "ERROR",
    "ABORTED",
    "NO_SETTLED",
    "MALFORMED",
    "RECORD_LIMIT",
    "STDERR_LIMIT",
  ]) {
    await assert.rejects(fixture.code(baseline, task, controller().signal), /pi_/)
    assert.deepEqual(await activeContainers(), [])
  }
  await fixture.cleanup()
})

test("pause freezes detached children before export and timeout removes the entire cgroup", {
  timeout: 45000,
}, async () => {
  const fixture = new DockerRuntime({ ...config, image: protocolImage, agentTimeoutMs: 1500 })
  await fixture.preflight()
  const result = await fixture.code(baseline, "DETACHED", controller().signal)
  assert.ok(result.files.heartbeat)
  const final = Buffer.from(result.files.heartbeat.content)
  await pause(100)
  assert.deepEqual(result.files.heartbeat.content, final)
  assert.deepEqual(await activeContainers(), [])
  await assert.rejects(fixture.code(baseline, "TIMEOUT", controller().signal), /runtime_timeout/)
  assert.deepEqual(await activeContainers(), [])
  assert.equal(
    (await checked(["volume", "ls", "--quiet", "--filter", `label=io.reina.owner=${owned()}`]))
      .stdout.length,
    0,
  )
  await fixture.cleanup()
})

function request(socketPath, capability, data, extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method: "POST",
        path: "/v1/chat/completions",
        headers: {
          authorization: `Bearer ${capability}`,
          "content-type": "application/json",
          ...extra.headers,
        },
        ...extra,
      },
      (res) => {
        res.on("error", reject)
        res.resume()
        res.on("end", () => resolve(res.statusCode))
      },
    )
    req.on("error", reject)
    req.end(typeof data === "string" ? data : JSON.stringify(data))
  })
}

test("Unix gateway rejects wrong capabilities, endpoints, routing fields, forwarding, expiry, budgets and oversized bodies", {
  timeout: 15000,
}, async () => {
  const socket = path.join(directory, "gateway-test.sock")
  const gateway = new ModelGateway(config, socket, { requests: 24, lifetimeMs: 10000 })
  await gateway.listen()
  const body = { model: "fixture", messages: [{ role: "user", content: "hello" }], stream: true }
  try {
    assert.equal(await request(socket, "wrong", body), 401)
    assert.equal(
      await request(socket, gateway.capability, body, { path: "http://169.254.169.254/" }),
      403,
    )
    assert.equal(
      await request(socket, gateway.capability, body, {
        headers: {
          authorization: `Bearer ${gateway.capability}`,
          "content-type": "application/json",
          "x-forwarded-host": "elsewhere",
        },
      }),
      403,
    )
    await assert.rejects(
      request(socket, gateway.capability, body, { method: "CONNECT", path: "169.254.169.254:80" }),
    )
    assert.equal(await request(socket, gateway.capability, { ...body, model: "other" }), 400)
    assert.equal(
      await request(socket, gateway.capability, { ...body, base_url: "http://elsewhere" }),
      400,
    )
    assert.equal(
      await request(socket, gateway.capability, {
        ...body,
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "http://elsewhere" } }],
          },
        ],
      }),
      400,
    )
    assert.equal(
      await request(socket, gateway.capability, { ...body, tools: [{ type: "web_search" }] }),
      400,
    )
    assert.equal(
      await request(socket, gateway.capability, {
        ...body,
        tools: [
          {
            type: "function",
            function: { name: "read", parameters: {}, endpoint: "http://elsewhere" },
          },
        ],
      }),
      400,
    )
    assert.equal(
      await request(socket, gateway.capability, {
        ...body,
        tools: [
          {
            type: "function",
            function: { name: "read", parameters: { $ref: "http://elsewhere" } },
          },
        ],
      }),
      400,
    )
    assert.equal(
      await request(socket, gateway.capability, { ...body, tool_choice: { type: "web_search" } }),
      400,
    )
    assert.equal(
      await request(socket, gateway.capability, {
        ...body,
        stream_options: { include_usage: true, route: "elsewhere" },
      }),
      400,
    )
    assert.equal(await request(socket, gateway.capability, { ...body, max_tokens: 999999 }), 200)
    assert.equal(
      await request(socket, gateway.capability, {
        ...body,
        messages: [{ role: "user", content: "CASE:REDIRECT" }],
      }),
      502,
    )
    await assert.rejects(
      request(socket, gateway.capability, {
        ...body,
        messages: [{ role: "user", content: "CASE:OVERSIZED" }],
      }),
    )
    const oversized = await request(socket, gateway.capability, "x".repeat(1048577)).catch(
      () => 413,
    )
    assert.equal(oversized, 413)
    gateway.revoke()
    assert.equal(await request(socket, gateway.capability, body), 401)
  } finally {
    await gateway.close()
  }
  for (const requests of [8, 24]) {
    const budget = new ModelGateway(config, socket, { requests, lifetimeMs: 10000 })
    await budget.listen()
    try {
      const initial = model.calls.length
      for (let requestNumber = 0; requestNumber < requests; requestNumber++)
        assert.equal(await request(socket, budget.capability, body), 200)
      assert.equal(await request(socket, budget.capability, body), 429)
      assert.equal(model.calls.length - initial, requests)
    } finally {
      await budget.close()
    }
  }
  const expired = new ModelGateway(config, socket, { requests: 1, lifetimeMs: 10 })
  await expired.listen()
  try {
    await pause(30)
    assert.equal(await request(socket, expired.capability, body), 401)
  } finally {
    await expired.close()
  }
})
