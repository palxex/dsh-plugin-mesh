/**
 * 端口池自测：验证"同机两个实例各绑一个端口，仍然互相看得见"。
 *
 *   node lib/_selftest-portpool.mjs [基端口]
 *
 * 背景（2026-10 的真实事故）：Windows 桌面端 + WSL 里的 dsh，WSL 开了 mirrored
 * 网络模式，两边共享同一套 IP 和端口空间。先启动的那个独占 UDP 45892 和 TCP 45917，
 * 后启动的拿到 EACCES / EADDRINUSE，组播 socket 从未建立 —— 它既发不出心跳也收不到，
 * 只能靠主动扫描兜底；而扫描当时又只扫"自己回退后的端口"，于是永远 0 命中。
 *
 * 覆盖四件事：
 *   1. 组播：池内第一个端口被占时，绑到池内下一个（而不是随机端口）；
 *   2. 组播：心跳发往池内**全部**端口（对端可能绑在另一个端口上）；
 *   3. 组播：两个实例各绑一个端口时能互相发现（不再是"有你没我"）；
 *   4. 对端服务（TCP）：同一套回退顺序，池内全占才退回随机端口。
 *
 * 组播占位用**不带 SO_REUSEADDR** 的 socket：这样在 Linux/macOS/Windows 上都能
 * 确定性地挡住后续带 reuseAddr 的绑定，不依赖各平台对端口共享的不同态度。
 */
import dgram from "node:dgram";
import net from "node:net";
import { MeshDiscovery, MESH_GROUP, APP_TAG } from "./discovery.js";
import { listenOnPortPool } from "./portpool.js";

const BASE = Number(process.argv[2] ?? 46100);
const POOL = [BASE, BASE + 1, BASE + 2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
};

/** 占住一个 UDP 端口，故意不设 reuseAddr —— 让后来者的绑定必然失败。 */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket("udp4");
    s.once("error", reject);
    s.bind(port, () => resolve(s));
  });
}

/** 在某个端口上收组播报文。 */
function watch(port) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const got = [];
    s.once("error", reject);
    s.on("message", (buf, rinfo) => {
      try {
        const msg = JSON.parse(buf.toString("utf8"));
        if (msg?.app === APP_TAG) got.push({ id: msg.id, from: rinfo.address, to: port });
      } catch {
        /* 不是我们的报文 */
      }
    });
    s.bind(port, () => {
      s.addMembership(MESH_GROUP);
      resolve({ socket: s, got });
    });
  });
}

const mk = (name) =>
  new MeshDiscovery({
    id: `portpool-${name}-${process.pid}`,
    port: 45917,
    meta: { machine: name, user: "tester", profile: "selftest", version: "selftest" },
    intervalMs: 400,
    ttlMs: 3000,
    multicastPorts: POOL,
  });

async function main() {
  console.log(`端口池自测：基端口 ${BASE}，池 ${POOL.join("/")}\n`);

  // ── 1. 池内第一个端口被占 → 绑到池内下一个 ──
  console.log("1) 组播：主端口被占用时的回退");
  const blocker = await occupy(BASE);
  const d1 = mk("alpha");
  d1.on("diagnostic", (m) => console.log(`     [alpha] ${m}`));
  d1.start();
  await sleep(300);

  const bound1 = d1.boundMulticastPort;
  check(bound1 > 0, "绑上了某个端口", `boundPort=${bound1}`);
  check(bound1 !== BASE, "没去抢被占用的主端口", `主端口=${BASE}`);
  check(POOL.includes(bound1), "绑的是池内端口（不是随机端口）", `池=${POOL.join("/")}`);

  // ── 2. 心跳发往池内全部端口 ──
  console.log("\n2) 组播：心跳是否发往池内全部端口");
  // d1 绑的是 BASE+1，这里在 BASE+2 上听 —— 只发自己那个端口的实现会收不到
  const watcher = await watch(BASE + 2);
  await sleep(1200);
  const heard = watcher.got.filter((x) => x.id.startsWith("portpool-alpha"));
  check(heard.length > 0, "未绑定的池内端口也能收到心跳", `收到 ${heard.length} 条 → 端口 ${BASE + 2}`);

  // ── 3. 两个实例各绑一个端口 → 互相发现 ──
  console.log("\n3) 组播：两个实例是否互相可见");
  const d2 = mk("beta");
  d2.on("diagnostic", (m) => console.log(`     [beta] ${m}`));
  d2.start();
  await sleep(2000);

  const beta = d2.boundMulticastPort;
  check(POOL.includes(beta) && beta !== BASE, "第二个实例也落在池内", `boundPort=${beta}`);

  const d1SeesBeta = d1.peers().some((p) => p.machine === "beta" && p.online);
  const d2SeesAlpha = d2.peers().some((p) => p.machine === "alpha" && p.online);
  check(d1SeesBeta, "alpha 看得见 beta");
  check(d2SeesAlpha, "beta 看得见 alpha");
  if (bound1 === beta) {
    console.log(`     ⓘ 本平台允许 SO_REUSEADDR 共享同一 UDP 端口（两个实例都绑在 ${beta}）`);
  }

  // ── 4. 对端服务（TCP）的端口池 ──
  console.log("\n4) 对端服务（TCP）：端口池回退");
  const tcpPool = [BASE + 10, BASE + 11, BASE + 12];
  const tcpHolder = net.createServer();
  await new Promise((res, rej) => {
    tcpHolder.once("error", rej);
    tcpHolder.listen(tcpPool[0], "0.0.0.0", res);
  });

  const srv = net.createServer();
  const picked = await listenOnPortPool(srv, tcpPool, {
    onSkip: (p, c) => console.log(`     [tcp] ${p} 被占用（${c}），试池内下一个…`),
  });
  check(picked.port === tcpPool[1], "主端口被占时绑到池内下一个", `实际 ${picked.port}`);
  check(picked.inPool === true, "判定为池内端口");
  srv.close();

  // 池内全被占用 → 只能退回随机端口，并明确标出不在池内
  const holders = [];
  for (const p of tcpPool) {
    const h = net.createServer();
    try {
      await new Promise((res, rej) => {
        h.once("error", rej);
        h.listen(p, "0.0.0.0", res);
      });
      holders.push(h);
    } catch {
      /* 已被占用（包括上面那个 tcpHolder），跳过 */
    }
  }
  const srv2 = net.createServer();
  const random = await listenOnPortPool(srv2, tcpPool);
  check(random.inPool === false && random.port > 0, "池内全被占用时退回随机端口", `实际 ${random.port}`);
  srv2.close();

  // ── 清理 ──
  for (const d of [d1, d2]) d.stop();
  try {
    watcher.socket.close();
  } catch {
    /* ignore */
  }
  blocker.close();
  tcpHolder.close();
  for (const h of holders) h.close();

  console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("自测异常:", err);
  process.exit(1);
});
