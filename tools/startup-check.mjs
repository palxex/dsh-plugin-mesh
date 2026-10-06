/**
 * 启动检查：在沙箱里把插件真跑一遍，专盯"启动后异步炸掉进程"这类问题。
 *
 *   node tools/startup-check.mjs          # 桩化网卡，只扫 4 个地址（快，进 npm run smoke）
 *   node tools/startup-check.mjs --real   # 真实网卡 + 完整预算，真连 tailnet（手动验证用）
 *
 * 为什么需要它：lib/_selftest-*.mjs 都是**直接调用**模块函数，绕过了 index.js 的接线。
 * 2026-10-06 就栽在这里 —— index.js 把一个只有 {aborted} 的裸取消令牌当 AbortSignal
 * 传进了 directFetch，socket 出错时在事件回调里抛 TypeError，逃逸成未捕获异常，
 * 直接把 dsh web 打挂。单测全绿，`dsh web` 起不来。
 *
 * 所以这里做的是**集成**验证：真实调用 apply()、真实打开启动扫描、真实等待异步回调，
 * 任何 uncaughtException / unhandledRejection 都算失败。
 *
 * 全程不碰真实 ~/.dsh（DSH_HOME 指向临时目录），也不开组播。
 */
import { mkdtempSync, mkdirSync, symlinkSync, cpSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import assert from "node:assert/strict";

const REAL = process.argv.includes("--real");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DSH_MODULES =
  process.env.DSH_MODULES || "/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

// ───────────────────────── 先装"未捕获异常"探针 ─────────────────────────
//
// 必须在 apply() 之前装好：坏版本的异常是在 socket 回调里抛的，没有这个
// handler 进程会直接退出（那正是用户看到的现象），我们也就无从断言。

const crashes = [];
process.on("uncaughtException", (err) => crashes.push(`uncaughtException: ${err?.message ?? err}`));
process.on("unhandledRejection", (err) => crashes.push(`unhandledRejection: ${err?.message ?? err}`));

// ───────────────────────── 沙箱 ─────────────────────────

const sandbox = mkdtempSync(join(tmpdir(), "mesh-startup-"));
const scope = join(sandbox, "node_modules", "@deepseek-ai");
mkdirSync(scope, { recursive: true });
let linked = 0;
for (const name of readdirSync(DSH_MODULES)) {
  try {
    symlinkSync(join(DSH_MODULES, name), join(scope, name), "dir");
    linked += 1;
  } catch {
    /* 已存在 */
  }
}
const pkgDir = join(sandbox, "node_modules", "@palxex", "dsh-plugin-mesh");
mkdirSync(pkgDir, { recursive: true });
for (const item of ["lib", "client", "package.json", "cordis.patch.yml"]) {
  cpSync(join(ROOT, item), join(pkgDir, item), { recursive: true });
}
const dshHome = join(sandbox, "dsh-home");
mkdirSync(dshHome, { recursive: true });
process.env.DSH_HOME = dshHome;

// ───────────────────────── 网卡 ─────────────────────────

const iface = (address, mac = "aa:bb:cc:dd:ee:ff") => [
  { address, netmask: "255.255.255.0", family: "IPv4", mac, internal: false, cidr: `${address}/24` },
];
if (!REAL) {
  os.networkInterfaces = () => ({
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
    enp34s0: iface("192.168.1.10"),
    tailscale0: iface("100.64.7.2"),
  });
}

// ───────────────────────── 假 ctx ─────────────────────────

const logs = [];
const warns = [];
const cleanups = [];
const registered = [];

const ctx = {
  logger: {
    info: (m) => logs.push(String(m)),
    warn: (m) => warns.push(String(m)),
    error: (m) => warns.push(`ERROR ${m}`),
  },
  effect: (fn) => {
    try {
      const disposer = fn();
      if (typeof disposer === "function") cleanups.push(disposer);
    } catch (err) {
      warns.push(`ERROR effect: ${err?.message ?? err}`);
    }
    return () => {};
  },
  tools: { register: (t) => registered.push(t) },
  webServer: { register: () => {} },
  emit: () => {},
  inject: () => {},
  on: () => {},
};

// ───────────────────────── 跑 ─────────────────────────

const mod = await import(pathToFileURL(join(pkgDir, "lib", "index.js")).href);
const config = mod.Config({
  enabled: true,
  port: 0,
  useMulticast: false, // 不碰组播，免得和正在跑的实例抢端口
  scanOnStart: true, // ★ 关键：这条路径会跑 runScan，并传入取消令牌
  scanIntervalMs: 0, // 关掉周期扫描，避免噪声
  pingIntervalMs: 0,
  scanTimeoutMs: REAL ? 800 : 300,
  scanConcurrency: REAL ? 64 : 4,
  scanMaxAddresses: REAL ? 1024 : 4, // 桩化模式下只扫 4 个地址
});

console.log(`沙箱 ${sandbox}（${linked} 个 @deepseek-ai 包）  模式=${REAL ? "真实网卡" : "桩化网卡"}`);
console.log("启动插件（scanOnStart=true，会走 runScan + 取消令牌）…\n");

mod.apply(ctx, config);

// 等启动扫描跑完（含重试循环的第一轮）。桩化模式扫 4 个地址，300ms 足够；
// 真实模式给足时间。
const waitMs = REAL ? 20000 : 3000;
await new Promise((r) => setTimeout(r, waitMs));

// ───────────────────────── 判定 ─────────────────────────

let passed = 0;
let failed = 0;
function check(title, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${title}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${title}\n      ${err?.message ?? err}`);
  }
}

check("插件启动没有报错", () => {
  const errs = warns.filter((w) => w.startsWith("ERROR"));
  assert.deepEqual(errs, [], `不该有错误: ${errs.join(" | ")}`);
  assert.ok(logs.some((l) => l.includes("已启动")), `缺少启动日志: ${logs.join(" | ")}`);
});

check("★ 没有任何未捕获异常 / 未处理的 Promise 拒绝（这里曾把 dsh web 打挂）", () => {
  assert.deepEqual(crashes, [], `出现未捕获异常:\n      ${crashes.join("\n      ")}`);
});

check("启动扫描真的跑了（否则本检查是空的）", () => {
  const line = logs.find((l) => l.includes("启动扫描"));
  assert.ok(line, `没有启动扫描日志: ${logs.join(" | ")}`);
  assert.match(line, /探测 \d+ 个地址/);
});

check("扫描完成并给出结果", () => {
  assert.ok(
    logs.some((l) => /启动扫描#1完成/.test(l)),
    `没有扫描完成日志: ${logs.join(" | ")}`,
  );
});

if (REAL) {
  check("真实环境下扫到了 tailnet 对端", () => {
    const line = logs.find((l) => /启动扫描#1完成: 命中 [1-9]/.test(l));
    assert.ok(line, `未命中任何对端。日志:\n${logs.join("\n")}`);
  });
}

// ───────────────────────── 收尾 ─────────────────────────

for (const dispose of cleanups) {
  try {
    dispose();
  } catch {
    /* 忽略 */
  }
}
await new Promise((r) => setTimeout(r, 200)); // 让残留回调有机会炸出来
if (crashes.length > 0 && failed === 0) {
  failed += 1;
  console.log(`  ✗ 收尾阶段出现未捕获异常:\n      ${crashes.join("\n      ")}`);
}

rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "✅" : "❌"} 通过 ${passed} / ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
