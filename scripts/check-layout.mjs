import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

const pin = JSON.parse(readFileSync("third_party/solidcraft.json", "utf8"));
const tree = execFileSync("git", ["ls-tree", "-rz", pin.commit], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
const patches = new Set(pin.localPatches);
const upstreamPaths = new Set();
let checked = 0;
for (const entry of tree.split("\0").filter(Boolean)) {
  const [metadata, path] = entry.split("\t");
  const [mode, type, expected] = metadata.split(" ");
  upstreamPaths.add(path);
  if (type !== "blob") throw new Error(`Unexpected upstream object: ${path}`);
  const target = `third_party/solidcraft/${path}`;
  const stat = lstatSync(target);
  if (patches.has(path)) continue;
  const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(target)) : readFileSync(target);
  const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`Unrecorded upstream change: ${path}`);
  if ((mode === "120000") !== stat.isSymbolicLink()) throw new Error(`Changed file kind: ${path}`);
  if (process.platform !== "win32" && mode === "100755" && !(stat.mode & 0o111)) throw new Error(`Lost executable permission: ${path}`);
  checked++;
}
const localFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "third_party/solidcraft/"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
for (const file of localFiles.split("\0").filter(Boolean)) {
  const relative = file.slice("third_party/solidcraft/".length);
  if (!upstreamPaths.has(relative) && !patches.has(relative)) throw new Error(`Unrecorded upstream addition: ${relative}`);
}
const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
const actualMembers = metadata.packages.filter((pkg) => metadata.workspace_members.includes(pkg.id)).map((pkg) => pkg.name).sort();
const expectedMembers = ["madori-geometry", "madori-housing", "madori-modeling", "madori-viewer"];
if (JSON.stringify(actualMembers) !== JSON.stringify(expectedMembers)) throw new Error(`Unexpected workspace members: ${actualMembers.join(", ")}`);
const viewerDependencies = execFileSync("cargo", ["tree", "--locked", "-p", "madori-viewer", "--target", "wasm32-unknown-unknown", "--edges", "normal", "--prefix", "none"], { encoding: "utf8" });
if (/^solidcraft-(engine|doc|kernel|ui-egui) /m.test(viewerDependencies)) throw new Error("The browser viewer must not include editing or egui crates");
const nativeDependencies = execFileSync("cargo", ["tree", "--locked", "-p", "madori-geometry", "--edges", "normal", "--prefix", "none"], { encoding: "utf8" });
if (/^(egui|eframe|winit|solidcraft-ui-egui) /m.test(nativeDependencies)) throw new Error("The native geometry service must not include the upstream UI");
const nativeFeatures = execFileSync("cargo", ["tree", "--locked", "-p", "madori-geometry", "--edges", "features", "--prefix", "none"], { encoding: "utf8" });
if (!nativeFeatures.includes('solidcraft-io feature "external-workspace"') || nativeFeatures.includes('solidcraft-io feature "trust-unknown-source"')) throw new Error("The service must not trust a cache fingerprint from the upstream workspace");
console.log(`Layout passed: ${checked} unchanged upstream files, ${patches.size} recorded patch files, four service Rust crates.`);
