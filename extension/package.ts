/**
 * Builds the extension and zips extension/dist into
 * extension/followthrough-recorder-<version>.zip, the file the Chrome Web Store
 * upload form takes. The version comes from manifest.json.
 *
 * Run with: bun run package. Needs the `zip` command (macOS and most Linux).
 */
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const dist = join(root, "dist");

const build = Bun.spawnSync(["bun", "run", "build.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

const { version } = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")) as { version: string };
const zipPath = join(root, `followthrough-recorder-${version}.zip`);
if (existsSync(zipPath)) rmSync(zipPath);

// Zip from inside dist so manifest.json sits at the archive root, as the store requires.
const zip = Bun.spawnSync(["zip", "-r", "-X", "-q", zipPath, ".", "-x", "*.DS_Store"], { cwd: dist, stdout: "inherit", stderr: "inherit" });
if (zip.exitCode !== 0) {
  console.error("zip failed; is the `zip` command installed?");
  process.exit(zip.exitCode ?? 1);
}

console.log(`Packaged ${zipPath} (${(statSync(zipPath).size / 1024).toFixed(1)} KB)`);
