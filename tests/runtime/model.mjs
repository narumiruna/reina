import assert from "node:assert/strict"
import http from "node:http"

export async function fakeModel() {
  const calls = []
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    calls.push(body)
    try {
      assert.equal(req.url, "/v1/chat/completions")
      assert.equal(req.headers.authorization, "Bearer host-only-test-key")
      assert.equal(req.headers["x-forwarded-host"], undefined)
      assert.equal(body.model, "fixture")
      assert.equal(body.max_tokens, 4096)
      assert.equal(body.n, 1)
      assert.equal(body.store, false)
    } catch {
      res.writeHead(400).end()
      return
    }
    const task = body.messages
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n")
    if (task.includes("CASE:HANG")) return
    if (task.includes("CASE:REDIRECT")) {
      res.writeHead(302, { location: "http://169.254.169.254/" }).end()
      return
    }
    if (task.includes("CASE:OVERSIZED")) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(`data: ${"x".repeat(4 * 1024 * 1024 + 1)}\n\n`)
      return
    }
    if (task.includes("CASE:DENIED")) {
      res.writeHead(401).end('{"error":{"message":"fixture authorization denied"}}')
      return
    }
    if (task.includes("CASE:ERROR")) {
      res.writeHead(503).end('{"error":{"message":"fixture failure"}}')
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    const send = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      )
    const called = body.messages.some((message) => message.role === "tool")
    if (!called && (task.includes("CASE:CODE") || task.includes("CASE:TRIAGE"))) {
      const name = task.includes("CASE:CODE") ? "write" : "read"
      const args =
        name === "write"
          ? { path: "src/message.txt", content: "after 日本語\n" }
          : { path: "src/message.txt" }
      send({
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_fixture",
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      })
      send({}, "tool_calls")
    } else {
      const text = task.includes("CASE:TRIAGE")
        ? JSON.stringify({
            kind: "documentation",
            summary: "One typo has a specified correction.",
            missingInfo: [],
            fix: {
              eligible: true,
              category: "typo",
              reason: "One typo has a specified correction.",
              proposedFix: "Correct the specified word.",
              affectedFiles: ["src/message.txt"],
              verificationPlan: ["Run the baseline check."],
              requiresHumanDecision: false,
              risks: [],
            },
          })
        : "completed\u2028safely\u2029日本語"
      send({ role: "assistant", content: text })
      send({}, "stop")
    }
    res.write(
      `data: ${JSON.stringify({ id: "chatcmpl-fixture", choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
    )
    res.end("data: [DONE]\n\n")
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
