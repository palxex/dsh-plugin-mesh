/**
 * 包名一致性检查。
 *
 *   node tools/name-check.mjs
 *
 * 为什么需要它：插件名散落在四个地方，改名时必须**同时**改，漏一个就是运行时故障：
 *
 *   1. package.json            → name（权威值）
 *   2. cordis.patch.yml        → insert 行的 name（宿主按这个找包）
 *   3. client/client.js        → __ModuleLoader__.load({ id })（浏览器端按**包名**索引）
 *   4. lib/index.js            → export const name（cordis 插件名，可不等于包名）
 *
 * 2026-10-07 就栽在第 3 项：仓库从 dsh-plugin-mesh 改名为 @palxex/dsh-plugin-mesh 时
 * 漏了 client 的注册 id，结果网页报
 *
 *   @palxex/dsh-plugin-mesh: import failed: client-modules: could not load ...
 *   loaded without registering "@palxex/dsh-plugin-mesh" via __ModuleLoader__.load
 *
 * 第 4 项只做提示（它是插件自己的标识，不要求等于包名）。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const pkg = JSON.parse(read("package.json"));
const expected = pkg.name;
const problems = [];

// 1) cordis.patch.yml 的 insert 行
const patch = read("cordis.patch.yml");
const patchNames = [...patch.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((m) => m[1]);
if (patchNames.length === 0) {
  problems.push("  ❌ cordis.patch.yml 里找不到 insert 行的 name");
} else {
  for (const n of patchNames) {
    if (n !== expected) problems.push(`  ❌ cordis.patch.yml 的 name = "${n}"，应为 "${expected}"`);
  }
}

// 2) client 的 __ModuleLoader__.load({ id })
const client = read("client/client.js");
const loadIds = [...client.matchAll(/__ModuleLoader__\.load\(\s*\{[\s\S]{0,200}?\bid:\s*"([^"]+)"/g)].map((m) => m[1]);
if (loadIds.length === 0) {
  problems.push("  ❌ client/client.js 里找不到 __ModuleLoader__.load({ id })");
} else {
  for (const id of loadIds) {
    if (id !== expected) {
      problems.push(
        `  ❌ client/client.js 的 __ModuleLoader__.load id = "${id}"，应为 "${expected}"\n` +
          `     （浏览器端按包名索引；对不上就会报 "loaded without registering ..."）`,
      );
    }
  }
}

// 3) lib/index.js 的 export const name —— 只提示
const lib = read("lib/index.js");
const m = lib.match(/export const name\s*=\s*"([^"]+)"/);
const cordisName = m ? m[1] : "(未声明)";
const hint = cordisName !== expected;

console.log(`package.json name = ${expected}\n`);
console.log(`  cordis.patch.yml insert name : ${patchNames.join(", ") || "(无)"}`);
console.log(`  client 注册 id               : ${loadIds.join(", ") || "(无)"}`);
console.log(`  lib/index.js 的 cordis name  : ${cordisName}${hint ? "   ← 与包名不同（允许，仅提示）" : ""}`);
console.log("");

for (const p of problems) console.log(p);
if (problems.length > 0) {
  console.log(`\n共 ${problems.length} 处不一致 —— 改名时漏改了。`);
  process.exit(1);
}
console.log("  ✅ 包名在 patch 与 client 注册处都一致");
