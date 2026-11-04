import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { dockerCommand } from "../../dist/agent/sandbox.js"
import { lock, manifest } from "./fixture.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

test("Compose prepares a worker, shares runtime binds, and preserves private state", {
  timeout: 290000,
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "reina-compose-test-"))
  const state = `/var/lib/reina/test-${randomUUID()}`
  const args = [
    "compose",
    "--project-name",
    `reina-test-${randomUUID()}`,
    "--project-directory",
    directory,
    "--env-file",
    path.join(directory, ".env"),
    "--file",
    path.join(root, "compose.yaml"),
    "--file",
    path.join(directory, "override.json"),
  ]
  const compose = async (argv) => {
    let diagnostics = ""
    const result = await dockerCommand([...args, ...argv], {
      timeoutMs: 240000,
      limit: 512 * 1024,
      stderr: (chunk) => {
        diagnostics += chunk.toString()
        assert.ok(diagnostics.length <= 512 * 1024, "Compose diagnostic output limit")
      },
    })
    assert.equal(result.exitCode, 0, diagnostics)
    return result.stdout.toString()
  }
  try {
    await mkdir(path.join(directory, "snapshot"))
    await writeFile(path.join(directory, "snapshot/package.json"), manifest)
    await writeFile(path.join(directory, "snapshot/package-lock.json"), lock)
    await writeFile(
      path.join(directory, ".env"),
      "TARGET_DIR=./snapshot\nWEBHOOK_SECRET='fixture-$not_expanded#secret'\n",
      { mode: 0o600 },
    )
    const image = { image: "reina-controller-fixture:local", build: { context: root } }
    await writeFile(
      path.join(directory, "override.json"),
      JSON.stringify({
        services: {
          reina: {
            ...image,
            restart: "no",
            volumes: [
              {
                type: "bind",
                source: path.join(root, "tests/runtime"),
                target: "/fixtures",
                read_only: true,
              },
            ],
          },
          "prepare-worker": image,
        },
      }),
    )

    assert.equal((await compose(["config", "--services"])).trim(), "reina")
    const config = JSON.parse(await compose(["--profile", "setup", "config", "--format", "json"]))
    const service = config.services.reina
    assert.equal(service.network_mode, "host")
    assert.equal(service.ports, undefined)
    assert.equal(service.environment.REINA_STATE_DIR, "/var/lib/reina")
    assert.equal(service.environment.DOCKER_HOST, "unix:///var/run/docker.sock")
    const staging = service.volumes.find((mount) => mount.target === service.environment.TMPDIR)
    assert.equal(staging.type, "bind")
    assert.equal(staging.source, staging.target)
    assert.ok(
      service.volumes.some((mount) => mount.type === "volume" && mount.target === "/var/lib/reina"),
    )
    assert.equal(config.services["prepare-worker"].environment?.WEBHOOK_SECRET, undefined)
    const snapshot = config.services["prepare-worker"].volumes.find(
      (mount) => mount.target === "/snapshot",
    )
    assert.equal(snapshot.source, path.join(directory, "snapshot"))
    assert.equal(snapshot.read_only, true)
    assert.equal(snapshot.bind.create_host_path, false)

    await compose(["build", "reina"])
    const command = config.services["prepare-worker"].command[0]
    assert.ok(command.includes("exec node scripts/prepare-worker.mjs /snapshot reina-worker:local"))
    const output = await compose([
      "run",
      "--rm",
      "-T",
      "prepare-worker",
      command.replace("reina-worker:local", "reina-compose-worker-fixture:local"),
    ])
    const worker = output.match(/sha256:[a-f0-9]{64}\s*$/)?.[0].trim()
    assert.ok(worker, "Preparation must print an immutable worker image ID")

    const controller = async (script) =>
      compose([
        "run",
        "--rm",
        "-T",
        "--env",
        `REINA_STATE_DIR=${state}`,
        "reina",
        "node",
        "--input-type=module",
        "-e",
        script,
      ])
    await controller(`
      import assert from 'node:assert/strict';
      import { existsSync, statSync } from 'node:fs';
      import { DockerRuntime } from './dist/agent/sandbox.js';
      import { Store } from './dist/jobs/store.js';
      import { baseline } from '/fixtures/fixture.mjs';
      import { fakeModel } from '/fixtures/model.mjs';

      assert.equal(process.getuid(), 0);
      assert.equal(process.env.WEBHOOK_SECRET, 'fixture-$not_expanded#secret');
      for (const directory of [process.env.REINA_STATE_DIR, process.env.TMPDIR]) {
        assert.equal(statSync(directory).mode & 0o777, 0o700);
      }
      for (const file of ['.env', '.git', 'src', 'node_modules/typescript']) {
        assert.equal(existsSync('/app/' + file), false);
      }
      const store = new Store(process.env.REINA_STATE_DIR);
      const model = await fakeModel();
      const runtime = new DockerRuntime({
        repository: { owner: 'fixture', name: 'fixture', id: 77, installationId: 77 },
        stateDir: process.env.REINA_STATE_DIR,
        image: ${JSON.stringify(worker)},
        model: 'fixture',
        modelUrl: model.url,
        modelKey: 'host-only-test-key',
        agentTimeoutMs: 30000,
      });
      try {
        await runtime.preflight();
        const decision = JSON.parse(await runtime.triage(baseline, 'CASE:TRIAGE', new AbortController().signal));
        assert.equal(decision.eligible, true);
        assert.equal(model.calls.length, 2);
        const reply = model.calls[1].messages.find(message => message.role === 'tool');
        assert.ok(JSON.stringify(reply).includes('before'), JSON.stringify(reply));
        store.saveScanPage(7);
      } finally {
        try { await runtime.cleanup(); }
        finally { await model.close(); store.close(); }
      }
    `)
    await controller(`
      import assert from 'node:assert/strict';
      import { Store } from './dist/jobs/store.js';
      const store = new Store(process.env.REINA_STATE_DIR);
      try { assert.equal(store.scanPage(), 7); }
      finally { store.close(); }
    `)
  } finally {
    try {
      // Only this randomly named, credential-free test project owns these volumes.
      await compose(["down", "--volumes", "--remove-orphans"])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})
