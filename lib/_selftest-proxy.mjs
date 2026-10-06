/**
 * 代理绕过回归测试。
 *
 *   node lib/_selftest-proxy.mjs
 *
 * 复现的就是"单向发现"那个故障：DSH 全局挂了代理（`NODE_USE_ENV_PROXY=1` +
 * `http_proxy`），而 undici 的 `no_proxy` 只认精确主机名和 `*`，
 * 通配（`10.*`）和 CIDR（`100.64.0.0/10`）一律无效 —— 于是插件发往
 * tailnet 对端的请求全被丢给代理，代理到不了 tailnet。
 *
 * 这里把 no_proxy 清空、代理指向一个死端口，制造出"全局 fetch 必然失败"的
 * 环境，然后断言插件自己的 directFetch 仍然直连成功。
 *
 * 必须在**子进程**里设环境变量：undici 只在首次 fetch 时读一次环境，
 * 进程内改 process.env 已经来不及了。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const DEAD_PROXY = "http://127.0.0.1:1"; // 没有进程监听 → 立刻 ECONNREFUSED

// ───────────────────────── 父进程：带着代理环境重跑自己 ─────────────────────────

if (!process.env.MESH_PROXY_TEST_CHILD) {
  console.log("在带代理的环境里重跑（NODE_USE_ENV_PROXY=1，代理指向死端口，no_proxy 清空）\n");
  const r = spawnSync(process.execPath, [SELF], {
    stdio: "inherit",
    env: {
      ...process.env,
      MESH_PROXY_TEST_CHILD: "1",
      NODE_USE_ENV_PROXY: "1",
      http_proxy: DEAD_PROXY,
      https_proxy: DEAD_PROXY,
      HTTP_PROXY: DEAD_PROXY,
      HTTPS_PROXY: DEAD_PROXY,
      no_proxy: "",
      NO_PROXY: "",
    },
  });
  process.exit(r.status ?? 1);
}

// ───────────────────────── 子进程：真正的断言 ─────────────────────────

const { createServer } = await import("node:http");
const assert = (await import("node:assert/strict")).default;
const { directFetch } = await import("./directfetch.js");
const { probePeerHealth, deliverTask } = await import("./peerlink.js");
const { scanForPeers } = await import("./scan.js");
const { MeshDiscovery } = await import("./discovery.js");

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

// 假对端：监听在回环上，但 no_proxy 已被清空 → 全局 fetch 会去撞死代理
const tasks = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const reply = (code, obj) => {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": body.length });
    res.end(body);
  };
  if (url.pathname === "/mesh/v1/health") {
    return reply(200, { v: 1, app: "dsh-mesh", id: "peer-proxy", machine: "远端", host: "127.0.0.1", port: 0 });
  }
  if (url.pathname === "/mesh/v1/task" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      tasks.push(JSON.parse(raw || "{}"));
      reply(200, { ok: true, id: JSON.parse(raw || "{}").id });
    });
    return;
  }
  return reply(404, { ok: false });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const TARGET = `http://127.0.0.1:${PORT}/mesh/v1/health`;

console.log(`假对端 127.0.0.1:${PORT}，死代理 ${DEAD_PROXY}，no_proxy=${JSON.stringify(process.env.no_proxy)}\n`);

console.log("前提：确认代理环境确实生效（否则本测试是空的）");

await test("全局 fetch 被代理吃掉 —— 这就是那个 bug 的现场", async () => {
  await assert.rejects(
    () => fetch(TARGET, { signal: AbortSignal.timeout(3000) }),
    (err) => {
      assert.notEqual(err.name, "TimeoutError", "应该是立刻 ECONNREFUSED（死代理），不是超时");
      return true;
    },
    "全局 fetch 竟然成功了，说明代理环境没生效，本测试无效",
  );
});

console.log("\ndirectFetch：同样环境下仍然直连");

await test("directFetch 绕过代理，直连成功", async () => {
  const res = await directFetch(TARGET, { timeoutMs: 3000 });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.app, "dsh-mesh");
});

await test("directFetch 支持 POST 正文与自定义头", async () => {
  const res = await directFetch(`http://127.0.0.1:${PORT}/mesh/v1/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Dsh-Mesh-Token": "tok" },
    body: JSON.stringify({ id: "direct-1", task: "直连" }),
    timeoutMs: 3000,
  });
  assert.equal(res.ok, true);
  assert.equal((await res.json()).ok, true);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].task, "直连");
});

await test("连不上时抛错，且超时用 TimeoutError 这个名字", async () => {
  await assert.rejects(() => directFetch("http://127.0.0.1:1/", { timeoutMs: 1000 }), (err) => {
    assert.ok(["ECONNREFUSED", "ETIMEDOUT"].includes(err.code) || err.name === "TimeoutError");
    return true;
  });
});

await test("非法 URL / 非 http 协议给出明确错误", async () => {
  await assert.rejects(() => directFetch("不是网址"), /不是合法的 URL/);
  await assert.rejects(() => directFetch("https://127.0.0.1:1/"), /只支持 http:/);
});

console.log("\nsignal 形态兼容（这里崩过一次，把 dsh web 进程打挂）");

await test("传轻量取消令牌 {aborted:false} 不会炸", async () => {
  const res = await directFetch(TARGET, { timeoutMs: 3000, signal: { aborted: false } });
  assert.equal(res.ok, true);
});

await test("令牌已 aborted 时立刻拒绝", async () => {
  await assert.rejects(
    () => directFetch(TARGET, { timeoutMs: 3000, signal: { aborted: true } }),
    (err) => err.name === "AbortError",
  );
});

await test("真正的 AbortSignal 两种状态都对", async () => {
  const ok = new AbortController();
  assert.equal((await directFetch(TARGET, { timeoutMs: 3000, signal: ok.signal })).ok, true);
  const dead = new AbortController();
  dead.abort();
  await assert.rejects(
    () => directFetch(TARGET, { timeoutMs: 3000, signal: dead.signal }),
    (err) => err.name === "AbortError",
  );
});

await test("★ 请求失败 + 传令牌时不得抛未捕获异常（回归：曾把 dsh web 打挂）", async () => {
  // 旧实现把 {aborted} 令牌当 AbortSignal 用，socket 出错时在 finish() 里调
  // signal.removeEventListener() 抛 TypeError；而 finish 跑在事件回调里，
  // 该异常逃逸成 uncaughtException，直接把 DSH 进程打死。
  const seen = [];
  const onUncaught = (e) => seen.push(e?.message ?? String(e));
  process.on("uncaughtException", onUncaught);
  try {
    await assert.rejects(() => directFetch("http://127.0.0.1:1/", { timeoutMs: 800, signal: { aborted: false } }));
    await assert.rejects(() => directFetch("http://192.0.2.1:45917/", { timeoutMs: 400, signal: { aborted: false } }));
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  assert.deepEqual(seen, [], `不该有未捕获异常: ${seen.join(" | ")}`);
});

await test("scanForPeers 传轻量令牌也能正常扫", async () => {
  const found = await scanForPeers({ ports: [PORT], addresses: ["127.0.0.1"], timeoutMs: 1500, signal: { aborted: false } });
  assert.equal(found.length, 1);
});

console.log("\n插件真实路径：扫描 / 探测 / 派发");

await test("scanForPeers 在代理环境下仍能扫到对端", async () => {
  const found = await scanForPeers({ ports: [PORT], addresses: ["127.0.0.1"], timeoutMs: 1500 });
  assert.equal(found.length, 1, "应该命中 1 台");
  assert.equal(found[0].app, "dsh-mesh");
  assert.equal(found[0].sourceAddress, "127.0.0.1");
});

let peer = null;
await test("probePeerHealth 在代理环境下仍能探到对端", async () => {
  peer = { id: "peer-proxy", port: PORT, host: "127.0.0.1", hosts: ["127.0.0.1"], sourceAddress: "127.0.0.1" };
  const hit = await probePeerHealth(peer, 2000);
  assert.ok(hit, "应该探测成功");
  assert.equal(hit.host, "127.0.0.1");
});

await test("deliverTask 在代理环境下仍能派发", async () => {
  const before = tasks.length;
  const out = await deliverTask({ target: peer, payload: { id: "t-proxy-1", task: "跨代理派发" }, token: "tok", timeoutMs: 3000 });
  assert.equal(out.res.ok, true);
  assert.equal(out.host, "127.0.0.1");
  assert.equal(tasks.length, before + 1);
  assert.equal(tasks[tasks.length - 1].task, "跨代理派发");
});

await test("批量扫连不上的地址时按时超时，不会挂住（连接阶段也必须有超时）", async () => {
  // 曾经的 bug：用 req.setTimeout() 设超时，它要等 socket **连上**才生效，
  // 于是扫一堆连不上的地址时整个扫描挂死。这里用一批黑洞地址（RFC 5737 TEST-NET）
  // 卡住回归。
  const t0 = Date.now();
  const found = await scanForPeers({
    ports: [45917],
    addresses: ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"],
    timeoutMs: 600,
    concurrency: 4,
  });
  const dt = Date.now() - t0;
  assert.equal(found.length, 0);
  assert.ok(dt < 3000, `4 个黑洞地址应在约 600ms 内超时结束，实际 ${dt}ms`);
});

await test("发现注册表链路（note → peers）在代理环境下不受影响", async () => {
  const d = new MeshDiscovery({ id: "self-proxy", port: 45999, meta: { machine: "本机" } });
  d.note({ app: "dsh-mesh", id: "peer-proxy", machine: "远端", host: "127.0.0.1", port: PORT }, "127.0.0.1");
  assert.equal(d.peers().length, 1);
  d.stop();
});

server.close();
console.log(`\n${failed === 0 ? "✅" : "❌"} 通过 ${passed} / ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
