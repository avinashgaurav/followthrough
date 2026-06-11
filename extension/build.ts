/**
 * Builds the extension into extension/dist, ready for
 * chrome://extensions -> Load unpacked.
 *
 * Uses Bun's built-in bundler; no esbuild or other dependencies.
 * Run with: bun run build.ts (or `bun run build` via package.json).
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const result = await Bun.build({
  entrypoints: [
    join(root, "src", "background.ts"),
    join(root, "src", "popup.ts"),
    join(root, "src", "offscreen.ts"),
  ],
  outdir: dist,
  target: "browser",
  format: "esm",
  minify: false,
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const staticFiles = ["manifest.json", "popup.html", "offscreen.html", "popup.css"];
for (const file of staticFiles) {
  copyFileSync(join(root, file), join(dist, file));
}

console.log(`Built ${result.outputs.length} bundles + ${staticFiles.length} static files -> ${dist}`);
