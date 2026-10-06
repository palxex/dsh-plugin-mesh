/**
 * 对端连接（换路）集成测试 —— 起一个真 HTTP server，走真 TCP。
 *
 *   node lib/_selftest-peerlink.mjs
 *
 * 这里验的是旧版最致命的那条：**回连只信对端自述的 host**。
 * 用 127.0.0.9 当"连不上的那个地址"（回环段里没进程监听 → 秒级 ECONNREFUSED），
 * 127.0.0.1 当"实测可达的那个地址"，构造出"对端自述的地址不通、但我们确实
 * 看得见它"的局面。
 */
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { peerHosts } from "./discovery.js";
import { probePeerHealth, resolvePeerHost, deliverTask, fetchPeerAny } from "./peerlink.js";

const DEAD = "127.0.0.9"; // 回环段里没人监听 → 立刻 ECONNREFUSED
const DEAD2 = "127.0.0.8";

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

const seen = { health: 0, hello: 0, task: [] };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const reply = (code, obj) => {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": body.length });
    res.end(body);
  };
  if (url.pathname === "/mesh/v1/health") {
    seen.health += 1;
    return reply(200, { app: "dsh-mesh", id: "peer-1", machine: "peer", host: "127.0.0.9", port: 0 });
  }
  if (url.pathname === "/mesh/v1/hello") {
    seen.hello += 1;
    return reply(200, { app: "dsh-mesh", id: "peer-1", peerPaired: true });
  }
  if (url.pathname === "/mesh/v1/task" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.task.push({ token: req.headers["x-dsh-mesh-token"], body: JSON.parse(raw || "{}") });
      reply(200, { ok: true, id: JSON.parse(raw || "{}").id });
    });
    return;
  }
  return reply(404, { ok: false });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
console.log(`假对端监听 127.0.0.1:${PORT}（"连不上"的地址用 ${DEAD}）\n`);

const reset = () => {
  seen.health = 0;
  seen.hello = 0;
  seen.task = [];
};

// ───────────────────────── 用例 ─────────────────────────

console.log("peerHosts() 排序");

await test("实测可达的 sourceAddress 排在自述 host 之前", () => {
  assert.deepEqual(peerHosts({ host: DEAD, hosts: [DEAD], sourceAddress: "127.0.0.1" }), ["127.0.0.1", DEAD]);
});

console.log("\nprobePeerHealth() / resolvePeerHost()");

await test("自述地址不通时，靠实测地址探测成功", async () => {
  reset();
  const peer = { id: "peer-1", port: PORT, host: DEAD, hosts: [DEAD], sourceAddress: "127.0.0.1" };
  const hit = await probePeerHealth(peer, 2000);
  assert.ok(hit, "应该探测成功");
  assert.equal(hit.host, "127.0.0.1");
  assert.equal(hit.body.id, "peer-1");
});

await test("所有候选地址都不通时返回 null（不抛异常）", async () => {
  reset();
  const peer = { id: "peer-1", port: PORT, host: DEAD, hosts: [DEAD], sourceAddress: DEAD2 };
  assert.equal(await probePeerHealth(peer, 1000), null);
  assert.equal(await resolvePeerHost(peer, 1000), "");
});

await test("没有 port 时直接返回 null", async () => {
  assert.equal(await probePeerHealth({ host: "127.0.0.1" }, 500), null);
});

await test("对端不是 mesh 服务时不算命中", async () => {
  const other = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hello: "world" }));
  });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  try {
    const hit = await probePeerHealth({ id: "x", port: other.address().port, host: "127.0.0.1" }, 1000);
    assert.equal(hit, null);
  } finally {
    other.close();
  }
});

console.log("\ndeliverTask() —— 派发时自动换路");

await test("★ 自述地址不通时，任务仍然派得出去（旧版这里直接失败）", async () => {
  reset();
  const marked = [];
  const peer = { id: "peer-1", port: PORT, host: DEAD, hosts: [DEAD], sourceAddress: "127.0.0.1" };
  const out = await deliverTask({
    target: peer,
    payload: { id: "t-1", task: "hello" },
    token: "secret-token",
    timeoutMs: 3000,
    discovery: { markReachable: (id, host) => marked.push([id, host]) },
  });
  assert.equal(out.res.ok, true);
  assert.equal(out.host, "127.0.0.1", "应该走实测可达的地址");
  assert.equal(seen.task.length, 1, "只能投递一次");
  assert.equal(seen.task[0].token, "secret-token", "配对码要带过去");
  assert.equal(seen.task[0].body.task, "hello");
  assert.deepEqual(marked, [["peer-1", "127.0.0.1"]], "连上后要回写实测地址");
});

await test("只信自述地址时确实会失败（复现旧版行为）", async () => {
  reset();
  const peer = { id: "peer-1", port: PORT, host: DEAD, hosts: [DEAD] }; // 没有 sourceAddress
  await assert.rejects(
    () => deliverTask({ target: peer, payload: { id: "t-x", task: "x" }, token: "", timeoutMs: 1500 }),
    /./,
    "没有任何可达地址时必须抛错",
  );
  assert.equal(seen.task.length, 0);
});

await test("单个候选地址时不做额外探测（行为与旧版一致）", async () => {
  reset();
  const peer = { id: "peer-1", port: PORT, host: "127.0.0.1", sourceAddress: "127.0.0.1" };
  assert.deepEqual(peerHosts(peer), ["127.0.0.1"]);
  const out = await deliverTask({ target: peer, payload: { id: "t-2", task: "solo" }, token: "", timeoutMs: 3000 });
  assert.equal(out.host, "127.0.0.1");
  assert.equal(seen.health, 0, "单地址不该先探活");
  assert.equal(seen.task.length, 1);
});

await test("多候选地址时先探活，再只 POST 一次", async () => {
  reset();
  const peer = { id: "peer-1", port: PORT, host: DEAD, hosts: [DEAD, "127.0.0.1"], sourceAddress: "127.0.0.1" };
  const out = await deliverTask({ target: peer, payload: { id: "t-3", task: "multi" }, token: "", timeoutMs: 3000 });
  assert.equal(out.host, "127.0.0.1");
  assert.equal(seen.health, 1, "应该只探一次");
  assert.equal(seen.task.length, 1, "绝不能重复投递");
});

await test("全部不通时抛错，且没有副作用", async () => {
  reset();
  const peer = { id: "peer-1", port: PORT, host: DEAD, hosts: [DEAD], sourceAddress: DEAD2 };
  await assert.rejects(() => deliverTask({ target: peer, payload: { id: "t-4", task: "x" }, token: "", timeoutMs: 1500 }));
  assert.equal(seen.task.length, 0);
});

await test("没有候选地址时给出明确错误", async () => {
  await assert.rejects(
    () => deliverTask({ target: { id: "p", port: PORT, host: "" }, payload: {}, token: "" }),
    /没有可用地址/,
  );
});

await test("discovery.markReachable 抛错不影响派发结果", async () => {
  reset();
  const peer = { id: "peer-1", port: PORT, host: "127.0.0.1", sourceAddress: "127.0.0.1" };
  const out = await deliverTask({
    target: peer,
    payload: { id: "t-5", task: "y" },
    token: "",
    timeoutMs: 3000,
    discovery: { markReachable: () => { throw new Error("boom"); } },
  });
  assert.equal(out.res.ok, true);
});

await test("fetchPeerAny 对只读请求逐个试地址", async () => {
  reset();
  const peer = { id: "peer-1", port: PORT, host: DEAD, hosts: [DEAD], sourceAddress: "127.0.0.1" };
  const { host, res } = await fetchPeerAny(peer, "/mesh/v1/hello", { timeoutMs: 2000 });
  assert.equal(host, "127.0.0.1");
  assert.equal(res.status, 200);
  assert.equal(seen.hello, 1);
});

// ───────────────────────── 收尾 ─────────────────────────

server.close();
console.log(`\n${failed === 0 ? "✅" : "❌"} 通过 ${passed} / ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
