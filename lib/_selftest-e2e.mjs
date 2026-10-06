/**
 * 端到端：扫描 → 登记 → 派发，全程真 TCP，不依赖 DSH、不依赖组播。
 *
 *   node lib/_selftest-e2e.mjs
 *
 * 复现的是本次修复针对的真实场景：对端**广播的地址我们连不上**，
 * 但我们确实在另一条路上看得见它（Tailscale / 跨网段 / 对端换了网）。
 * 旧版只打对端自述的 host，这种局面下必然失败。
 */
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { MeshDiscovery, peerHosts } from "./discovery.js";
import { resolveScanPlan, scanForPeers } from "./scan.js";
import { deliverTask } from "./peerlink.js";

const DEAD = "127.0.0.9"; // 回环段里没人监听 → 立刻 ECONNREFUSED

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

// ───────────────────────── 假对端 ─────────────────────────
//
// 关键：它自述的地址是 DEAD（模拟"它以为自己在这个地址上、但我们到不了"），
// 而它实际监听在 127.0.0.1 —— 扫描时我们会在 127.0.0.1 上撞见它。

const tasks = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const reply = (code, obj) => {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": body.length });
    res.end(body);
  };
  if (url.pathname === "/mesh/v1/health") {
    return reply(200, {
      v: 1,
      app: "dsh-mesh",
      id: "peer-e2e",
      machine: "远端机器",
      hostname: "remote",
      mac: "aa:bb:cc:dd:ee:01",
      host: DEAD, // ← 自述地址是连不上的那个
      hosts: [DEAD],
      port: server.address().port,
      os: "linux test",
      user: "tester",
    });
  }
  if (url.pathname === "/mesh/v1/task" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      tasks.push(body);
      reply(200, { ok: true, id: body.id });
    });
    return;
  }
  return reply(404, { ok: false });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
console.log(`假对端：自述 ${DEAD}:${PORT}，实际监听 127.0.0.1:${PORT}\n`);

// ───────────────────────── 用例 ─────────────────────────

const discovery = new MeshDiscovery({
  id: "self-e2e",
  port: 45999,
  meta: { machine: "本机", user: "tester" },
  intervalMs: 5000,
  ttlMs: 20000,
});
discovery.start({ multicast: false }); // 只跑 sweep，不碰组播

console.log("扫描计划");

await test("本机 /24 与用户网段叠加，不再静默扫 0 个地址", () => {
  const plan = resolveScanPlan(["100.64.0.0/10"], 512);
  assert.ok(plan.addresses.length > 0);
  assert.ok(plan.addresses.some((ip) => ip.startsWith("100.64.")));
  assert.ok(plan.warnings.some((w) => /超出本次预算/.test(w)), "必须告警而不是静默截断");
});

console.log("\n扫描 → 登记");

let peer = null;

await test("扫到对端，且 sourceAddress 是实测地址而非自述地址", async () => {
  const found = await scanForPeers({ ports: [PORT], addresses: ["127.0.0.1"], timeoutMs: 1500 });
  assert.equal(found.length, 1, "应该命中 1 台");
  assert.equal(found[0].sourceAddress, "127.0.0.1");
  assert.equal(found[0].host, DEAD, "对端自述的仍是连不上的地址");
  discovery.note(found[0], found[0].sourceAddress);
  peer = discovery.peers()[0];
  assert.ok(peer, "对端应已登记");
  assert.equal(peer.machine, "远端机器");
  assert.equal(peer.sourceAddress, "127.0.0.1", "sourceAddress 必须是实测地址");
  assert.equal(peer.host, DEAD, "首选地址仍尊重对端自述");
  assert.deepEqual(peerHosts(peer), ["127.0.0.1", DEAD], "实测地址排最前");
});

await test("扫到的对端能正常派发（走实测地址）", async () => {
  const out = await deliverTask({
    target: peer,
    payload: { id: "t-e2e-1", task: "端到端任务", thread: "e2e" },
    token: "tok",
    timeoutMs: 3000,
    discovery,
  });
  assert.equal(out.res.ok, true);
  assert.equal(out.host, "127.0.0.1");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].task, "端到端任务");
  assert.equal(tasks[0].thread, "e2e");
});

await test("派发成功后对端记录自愈到实测地址", () => {
  const p = discovery.peers()[0];
  assert.equal(p.host, "127.0.0.1", "首选应已切到连得上的地址");
  assert.equal(p.sourceAddress, "127.0.0.1");
  assert.equal(peerHosts(p)[0], "127.0.0.1");
});

await test("重复派发仍然只打实测地址，且能连续成功", async () => {
  const p = discovery.peers()[0];
  const out = await deliverTask({ target: p, payload: { id: "t-e2e-2", task: "第二条" }, token: "", timeoutMs: 3000, discovery });
  assert.equal(out.res.ok, true);
  assert.equal(out.host, "127.0.0.1");
  assert.equal(tasks.length, 2);
});

await test("旧版行为（只信自述 host）在这个场景下必然失败", async () => {
  const legacyPeer = { id: "peer-e2e", port: PORT, host: DEAD }; // 没有 sourceAddress / hosts
  await assert.rejects(
    () => deliverTask({ target: legacyPeer, payload: { id: "t-e2e-3", task: "x" }, token: "", timeoutMs: 1500 }),
    /./,
  );
  assert.equal(tasks.length, 2, "失败的派发不能产生副作用");
});

await test("对端掉线后 sweep 能把它标记离线", async () => {
  // sweep 间隔 = max(2000, ttl/4)，所以 ttl 给小了也至少等 2s
  const d = new MeshDiscovery({ id: "self-2", port: 1, meta: {}, ttlMs: 1, keepMs: 60000 });
  d.start({ multicast: false }); // sweep 只在 start() 之后跑，与组播无关
  d.note({ app: "dsh-mesh", id: "p", machine: "p", host: "127.0.0.1", port: 1 }, "127.0.0.1");
  assert.equal(d.peers()[0].online, true, "刚登记时在线");
  await new Promise((r) => setTimeout(r, 2400));
  const p = d.peers()[0];
  assert.equal(p.online, false, "超过 ttl 应标记离线");
  assert.equal(d.peers().length, 1, "但仍保留在列表里");
  d.stop();
});

// ───────────────────────── 收尾 ─────────────────────────

discovery.stop();
server.close();
console.log(`\n${failed === 0 ? "✅" : "❌"} 通过 ${passed} / ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
