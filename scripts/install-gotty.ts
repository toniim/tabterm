// Downloads the GoTTY binary for the current OS/arch into bin/gotty.
// Runs on `bun install` via the package.json "postinstall" hook; also runnable
// directly with `bun scripts/install-gotty.ts`. Skips if bin/gotty exists.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { $ } from "bun";

const VERSION = "v1.5.0";
const DEST = "bin/gotty";

if (existsSync(DEST)) {
  console.log(`[gotty] ${DEST} already present, skipping download`);
  process.exit(0);
}

const osMap: Record<string, string> = { darwin: "darwin", linux: "linux" };
const archMap: Record<string, string> = { arm64: "arm64", x64: "amd64" };

const os = osMap[process.platform];
const arch = archMap[process.arch];
if (!os || !arch) {
  console.error(`[gotty] unsupported platform: ${process.platform}/${process.arch}`);
  console.error("[gotty] install GoTTY manually and place it at bin/gotty");
  process.exit(1);
}

const asset = `gotty_${VERSION}_${os}_${arch}.tar.gz`;
const url = `https://github.com/sorenisanerd/gotty/releases/download/${VERSION}/${asset}`;

mkdirSync("bin", { recursive: true });
console.log(`[gotty] downloading ${asset} …`);

const res = await fetch(url);
if (!res.ok) {
  console.error(`[gotty] download failed: ${res.status} ${url}`);
  process.exit(1);
}
await Bun.write(`bin/${asset}`, res);
await $`tar -xzf bin/${asset} -C bin`.quiet();
await $`rm bin/${asset}`.quiet();
chmodSync(DEST, 0o755);

const { stdout } = await $`${DEST} --version`.quiet();
console.log(`[gotty] installed: ${stdout.toString().trim()}`);
