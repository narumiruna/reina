import { spawn } from "node:child_process"

if (process.argv.includes("--version")) {
  process.stdout.write("1.5.0\n")
  process.exit(0)
}
let task = ""
for await (const chunk of process.stdin) task += chunk
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
emit({ type: "session", version: 3 })
if (task.includes("MALFORMED")) {
  process.stdout.write("not-json\n")
  process.exit(0)
}
if (task.includes("RECORD_LIMIT")) {
  process.stdout.write("x".repeat(1048577))
  process.exit(0)
}
if (task.includes("STDERR_LIMIT")) {
  process.stderr.write("x".repeat(65537))
  process.exit(0)
}
if (task.includes("DETACHED") || task.includes("TIMEOUT")) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');setInterval(()=>fs.writeFileSync('/workspace/heartbeat',String(Date.now())),5);",
    ],
    { detached: true, stdio: "ignore" },
  )
  child.unref()
}
if (task.includes("TIMEOUT")) {
  setInterval(() => {}, 1000)
} else {
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: task.includes("ERROR") ? "error" : "stop",
      content: [{ type: "text", text: "fixture final" }],
    },
  })
  emit({ type: "agent_end", messages: [] })
  if (!task.includes("NO_SETTLED"))
    emit({ type: "agent_settled", aborted: task.includes("ABORTED") })
}
