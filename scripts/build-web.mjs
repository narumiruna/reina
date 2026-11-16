import { fileURLToPath } from "node:url"
import { build } from "esbuild"

export async function setup() {
  await build({
    absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
    entryPoints: ["public/i18n.js"],
    outfile: "dist/browser/i18n.js",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
  })
}

if (import.meta.main) await setup()
