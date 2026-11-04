import { readFile } from "node:fs/promises"

for (let attempt = 0; attempt < 100; attempt++) {
  try {
    if ((await readFile("/tmp/reina-ready", "utf8")) === "ready") process.exit(0)
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 50))
}
process.exit(1)
