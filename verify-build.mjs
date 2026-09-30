import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";

const plugin = "Override-User-Avatars";
const directory = new URL(`./dist/${plugin}/`, import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
const bundle = await readFile(new URL("index.js", directory));

if (manifest.version !== "2.0.0") throw new Error(`Unexpected plugin version: ${manifest.version}`);
if (manifest.main !== "index.js") throw new Error(`Manifest main must be index.js, got: ${manifest.main}`);
if (!manifest.hash || manifest.hash !== createHash("sha256").update(bundle).digest("hex")) {
    throw new Error("Manifest hash does not match the generated bundle");
}
if (bundle.length === 0) throw new Error("Generated plugin bundle is empty");
await access(new URL("manifest.json", directory));

console.log(`Verified ${plugin} ${manifest.version}: manifest.json + index.js (${bundle.length} bytes)`);
