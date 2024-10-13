// Copies the gdal3.js runtime (JS worker, WASM, data) into public/gdal so Vite
// serves it as static files. Run automatically by `pnpm dev` / `pnpm build`.
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const src = dirname(require.resolve("gdal3.js"));
const dest = new URL("../public/gdal/", import.meta.url).pathname;
mkdirSync(dest, { recursive: true });
for (const f of ["gdal3.js", "gdal3WebAssembly.wasm", "gdal3WebAssembly.data"]) {
  const from = join(src, f);
  const to = join(dest, f);
  if (!existsSync(to) || statSync(to).size !== statSync(from).size) copyFileSync(from, to);
}
console.log(`gdal3.js runtime ready in public/gdal`);
