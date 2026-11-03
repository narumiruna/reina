import { access, mkdir, symlink, writeFile } from "node:fs/promises"
import http from "node:http"

// Immutable PID 1. Pi and repository commands run only through separate docker exec calls.
const phase = process.env.REINA_PHASE
if (!["triage", "code", "verify", "prepare"].includes(phase)) process.exit(1)
await mkdir("/tmp/home", { recursive: true, mode: 0o700 })
await mkdir("/tmp/reina-agent", { recursive: true, mode: 0o700 })
if (phase === "code" || phase === "verify") {
  await access("/opt/deps/node_modules")
  await symlink("/opt/deps/node_modules", "/workspace/node_modules")
}
if (phase === "triage" || phase === "code") {
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(403).end()
      req.resume()
      return
    }
    const upstream = http.request(
      {
        socketPath: "/run/reina-model.sock",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: req.headers.authorization ?? "",
          "content-type": req.headers["content-type"] ?? "",
          ...(req.headers["content-length"]
            ? { "content-length": req.headers["content-length"] }
            : {}),
          // The host also rejects forwarding headers. None are relayed here.
        },
        timeout: 60_000,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, {
          "content-type": response.headers["content-type"] ?? "application/json",
        })
        response.on("error", () => res.destroy())
        response.pipe(res)
      },
    )
    upstream.on("timeout", () => upstream.destroy())
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.on("aborted", () => upstream.destroy())
    req.on("error", () => upstream.destroy())
    res.on("close", () => upstream.destroy())
    req.pipe(upstream)
  })
  server.maxConnections = 8
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.on("connect", (_req, socket) => socket.destroy())
  server.on("upgrade", (_req, socket) => socket.destroy())
  server.on("clientError", (_error, socket) => socket.destroy())
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(3210, "127.0.0.1", resolve)
  })
}
await writeFile("/tmp/reina-ready", "ready", { mode: 0o400 })
setInterval(() => {}, 60_000)
