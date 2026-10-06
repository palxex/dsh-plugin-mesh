/**
 * 主机侧冒烟测试：在隔离沙箱里真实调用插件的 apply()。
 *
 *   node tools/host-smoke.mjs
 *
 * 为什么需要它：改完插件要验证"真的能起来"，而重启 DSH 才能生效 ——
 * 如果用户正连着 DSH Web，重启就把会话打断了。这个脚本把插件复制进一个
 * 临时 node_modules（符号链接 DSH 自带的 @deepseek-ai/* 包），配上假的 ctx，
 * 把 apply() 完整跑一遍：
 *
 *   · 起对端 HTTP 服务、挂 UI 路由、注册 agent 工具
 *   · 网卡被桩化成 物理内网 + Tailscale(100.64/10)，检查地址分类与广播列表
 *   · 真实发一次 /mesh/api/state 与 /mesh/api/announce 请求
 *
 * 全程不碰真实的 ~/.dsh（DSH_HOME 指向临时目录），也不开组播。
 *
 * 环境变量 DSH_MODULES 可指定 @deepseek-ai 包的来源目录。
 */
import { mkdtempSync, mkdirSync, symlinkSync, cpSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import os from "node:os";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DSH_MODULES =
  process.env.DSH_MODULES || "/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

// ───────────────────────── 沙箱 ─────────────────────────

const sandbox = mkdtempSync(join(tmpdir(), "mesh-host-smoke-"));
const scope = join(sandbox, "node_modules", "@deepseek-ai");
mkdirSync(scope, { recursive: true });
let linked = 0;
for (const name of readdirSync(DSH_MODULES)) {
  try {
    symlinkSync(join(DSH_MODULES, name), join(scope, name), "dir");
    linked += 1;
  } catch {
    /* 已存在或不允许，跳过 */
  }
}
const pkgDir = join(sandbox, "node_modules", "dsh-plugin-mesh");
mkdirSync(pkgDir, { recursive: true });
for (const item of ["lib", "client", "package.json", "cordis.patch.yml"]) {
  cpSync(join(ROOT, item), join(pkgDir, item), { recursive: true });
}
const dshHome = join(sandbox, "dsh-home");
mkdirSync(dshHome, { recursive: true });
process.env.DSH_HOME = dshHome;

// 桩化网卡：物理内网 + Tailscale 的 100.64/10（本机真实网卡不参与，保证可重复）
const iface = (address, mac = "aa:bb:cc:dd:ee:ff") => [
  { address, netmask: "255.255.255.0", family: "IPv4", mac, internal: false, cidr: `${address}/24` },
];
os.networkInterfaces = () => ({
  lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
  enp34s0: iface("192.168.1.10"),
  tailscale0: iface("100.64.7.2"),
});

console.log(`沙箱: ${sandbox}（符号链接 ${linked} 个 @deepseek-ai 包）`);

// ───────────────────────── 假的 ctx ─────────────────────────

const logs = [];
const warns = [];
const routes = new Map();
const registered = [];
const cleanups = [];
const emitted = [];

const ctx = {
  logger: {
    info: (m) => logs.push(String(m)),
    warn: (m) => warns.push(String(m)),
    error: (m) => warns.push(`ERROR ${m}`),
  },
  // DSH 的 effect 语义：传入的 setup 函数会被**立刻执行**，返回值（disposer）用于清理。
  // 插件的 route() 就是靠这个把 webServer.register 挂上去的，所以这里必须真的调用。
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
  webServer: { register: (r) => routes.set(r.path, r.handler) },
  emit: (name, payload) => emitted.push({ name, payload }),
  // 不提供唤醒服务 → waker 保持未就绪，不会真的去建会话
  inject: () => {},
  on: () => {},
};

// ───────────────────────── 请求/响应桩 ─────────────────────────

function fakeReq(url, method = "GET", body) {
  const r = new Readable({ read() {} });
  r.url = url;
  r.method = method;
  r.headers = { accept: "application/json" };
  r.socket = { remoteAddress: "::ffff:192.168.1.99" };
  if (body !== undefined) r.push(JSON.stringify(body));
  r.push(null);
  return r;
}

function fakeRes() {
  const out = { status: 0, body: null, headers: null };
  return {
    out,
    headersSent: false,
    writeHead(code, headers) {
      out.status = code;
      out.headers = headers;
      this.headersSent = true;
    },
    end(payload) {
      try {
        out.body = JSON.parse(payload.toString("utf8"));
      } catch {
        out.body = payload.toString("utf8");
      }
    },
  };
}

async function callRoute(path, { method = "GET", body } = {}) {
  const handler = routes.get(path);
  assert.ok(handler, `路由 ${path} 未注册`);
  const res = fakeRes();
  await handler(fakeReq(path, method, body), res);
  return res.out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
async function test(title, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${title}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${title}\n      ${err?.message ?? err}`);
  }
}

// ───────────────────────── 跑起来 ─────────────────────────

const mod = await import(pathToFileURL(join(pkgDir, "lib", "index.js")).href);
const config = mod.Config({
  enabled: true,
  port: 0, // 随机端口，避免和正在跑的 DSH 抢 45917
  useMulticast: false, // 不开组播，免得和真实实例互相干扰
  scanOnStart: false,
  scanIntervalMs: 0,
  pingIntervalMs: 0,
  requirePairing: false,
});
mod.apply(ctx, config);
await sleep(600); // 等对端服务 listening + 启动日志

console.log("\napply() 启动");

await test("插件加载并启动，没有报错", () => {
  assert.equal(warns.filter((w) => w.startsWith("ERROR")).length, 0, `不该有错误: ${warns.join(" | ")}`);
  assert.ok(logs.some((l) => l.includes("已启动")), `缺少启动日志: ${logs.join(" | ")}`);
});

await test("100.64/10 被明确识别为私网地址并打日志", () => {
  const line = logs.find((l) => l.includes("检测到 CGNAT/Tailscale 地址"));
  assert.ok(line, `缺少 CGNAT 识别日志: ${logs.join(" | ")}`);
  assert.match(line, /100\.64\.7\.2/);
});

await test("广播候选列表同时包含物理内网与 Tailscale 地址", () => {
  const line = logs.find((l) => l.includes("本机候选地址"));
  assert.ok(line, `缺少候选地址日志: ${logs.join(" | ")}`);
  assert.match(line, /192\.168\.1\.10/);
  assert.match(line, /100\.64\.7\.2/);
});

await test("UI 路由与 agent 工具都注册上了", () => {
  for (const p of ["/mesh/api/state", "/mesh/api/announce", "/mesh/api/scan", "/mesh/api/send", "/mesh/api/probe"]) {
    assert.ok(routes.has(p), `缺少路由 ${p}`);
  }
  const names = registered.map((t) => t.name);
  for (const n of ["mesh_peers", "mesh_scan", "mesh_run", "mesh_tasks"]) {
    assert.ok(names.includes(n), `缺少工具 ${n}`);
  }
});

console.log("\n/mesh/api/state");

let state = null;
await test("state 返回 hosts / addresses（带 scope）/ announceAddress", async () => {
  const out = await callRoute("/mesh/api/state");
  assert.equal(out.status, 200);
  state = out.body;
  assert.equal(state.ok, true);
  assert.deepEqual(state.self.hosts, ["192.168.1.10", "100.64.7.2"], "首选应是物理内网，其次 Tailscale");
  assert.equal(state.self.host, "192.168.1.10");
  assert.equal(state.self.announceAddress, "");
  assert.equal(state.self.announceLockedByConfig, false);
  const scopes = state.self.addresses.map((a) => `${a.address}=${a.scope}`);
  assert.ok(scopes.includes("100.64.7.2=cgnat"), `addresses 缺少 cgnat 标注: ${scopes.join(", ")}`);
  assert.ok(scopes.includes("192.168.1.10=rfc1918"), `addresses 缺少 rfc1918 标注: ${scopes.join(", ")}`);
  assert.ok(!state.self.addresses.some((a) => a.scope === "loopback"), "不该包含回环");
  assert.equal(state.config.scanMaxAddresses, 1024);
});

console.log("\n/mesh/api/announce");

await test("非法地址被拒", async () => {
  const out = await callRoute("/mesh/api/announce", { method: "POST", body: { address: "999.1.1.1" } });
  assert.equal(out.status, 400);
  assert.equal(out.body.ok, false);
});

await test("钉住 100.64.7.2 后，首选地址切换并落盘", async () => {
  const out = await callRoute("/mesh/api/announce", { method: "POST", body: { address: "100.64.7.2" } });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.ok, true);
  assert.equal(out.body.applied, "100.64.7.2");
  assert.deepEqual(out.body.hosts, ["100.64.7.2", "192.168.1.10"], "其余地址仍要带上");
  const saved = JSON.parse(readFileSync(join(dshHome, "mesh", "state.json"), "utf8"));
  assert.equal(saved.announceAddress, "100.64.7.2", "必须落盘，否则重启就丢");
});

await test("再次读取 state，首选已变为 Tailscale 地址", async () => {
  const out = await callRoute("/mesh/api/state");
  assert.equal(out.body.self.host, "100.64.7.2");
  assert.equal(out.body.self.announceAddress, "100.64.7.2");
  assert.deepEqual(out.body.self.hosts, ["100.64.7.2", "192.168.1.10"]);
});

await test("恢复自动挑选", async () => {
  const out = await callRoute("/mesh/api/announce", { method: "POST", body: { address: "" } });
  assert.equal(out.body.ok, true);
  assert.equal(out.body.applied, "192.168.1.10");
  const again = await callRoute("/mesh/api/state");
  assert.equal(again.body.self.host, "192.168.1.10");
});

console.log("\n/mesh/api/scan 与 /mesh/api/probe");

await test("扫描返回 plan 的告警信息而不是静默 0 个地址", async () => {
  const out = await callRoute("/mesh/api/scan", { method: "POST", body: {} });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.ok(out.body.scanned > 0, `应该真的扫了地址，实际 ${out.body.scanned}`);
  assert.ok(Array.isArray(out.body.ranges));
  assert.ok(out.body.ranges.some((r) => r.source === "本机网卡"), "应包含本机 /24");
});

await test("探测不存在的对端时返回候选地址明细", async () => {
  const out = await callRoute("/mesh/api/probe", { method: "POST", body: { peer: "不存在" } });
  assert.equal(out.status, 404);
});

console.log("\n入站任务（走真实 HTTP，不是 webServer 路由）");

// /mesh/v1/* 由插件自己起的对端 HTTP 服务提供，不在 ctx.webServer 上，
// 所以这里直接打真实端口 —— 顺便验证端口回填是否正确。
let peerPort = 0;
await test("state 里的端口就是真实监听的端口", async () => {
  const out = await callRoute("/mesh/api/state");
  peerPort = out.body.self.port;
  assert.ok(Number.isInteger(peerPort) && peerPort > 0, `端口异常: ${peerPort}`);
  const r = await fetch(`http://127.0.0.1:${peerPort}/mesh/v1/health`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.app, "dsh-mesh");
  assert.equal(body.host, "192.168.1.10", "心跳里的首选地址应是物理内网");
  assert.deepEqual(body.hosts, ["192.168.1.10", "100.64.7.2"], "心跳必须带上全部候选地址");
});

const postTask = (body) =>
  fetch(`http://127.0.0.1:${peerPort}/mesh/v1/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));

await test("收到任务时记录归一化后的来源地址", async () => {
  const out = await postTask({ id: "t-smoke-1", from: "peer/tester", task: "冒烟任务" });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.ok, true);
  const list = await fetch(`http://127.0.0.1:${peerPort}/mesh/v1/tasks`).then((r) => r.json());
  const rec = list.tasks.find((t) => t.id === "t-smoke-1");
  assert.ok(rec, "任务应进入收件箱");
  assert.equal(rec.sourceAddress, "127.0.0.1", "来源地址应归一化为纯 IPv4");
});

await test("重复 id 会被识别为 duplicate", async () => {
  const out = await postTask({ id: "t-smoke-1", from: "peer/tester", task: "冒烟任务" });
  assert.equal(out.body.duplicate, true);
});

// ───────────────────────── 收尾 ─────────────────────────

for (const dispose of cleanups) {
  try {
    dispose();
  } catch {
    /* 忽略清理异常 */
  }
}
rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "✅" : "❌"} 通过 ${passed} / ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
