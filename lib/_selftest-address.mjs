/**
 * 地址处理回归测试（不需要网络、不需要 DSH）。
 *
 *   node lib/_selftest-address.mjs
 *
 * 覆盖 2026-10 修的那批问题，每一条都对应一个真实故障：
 *   1. 100.64.0.0/10（RFC 6598 CGNAT / Tailscale）被当成"未知网卡"，
 *      广播哪个地址取决于 os.networkInterfaces() 的枚举顺序
 *   2. scanRanges 里写 /10 会被 expandCidr 静默丢掉，而且因为"配了 scanRanges"
 *      连本机 /24 兜底也一起跳过 → 扫 0 个地址、没有任何提示
 *   3. 回连只信对端自述的 host，实测可达的 sourceAddress 存而不用
 */
import os from "node:os";
import assert from "node:assert/strict";
import { MeshDiscovery, ipv4Scope, isCgnatIPv4, isPrivateIPv4, normalizeIPv4, preferredAddress, orderedLanAddresses, hostCandidates, peerHosts } from "./discovery.js";
import { resolveScanPlan, candidateAddresses } from "./scan.js";

const realNetworkInterfaces = os.networkInterfaces;
const iface = (address, mac = "aa:bb:cc:dd:ee:ff") => [
  { address, netmask: "255.255.255.0", family: "IPv4", mac, internal: false, cidr: `${address}/24` },
];
const loopback = () => [
  { address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" },
];
const useIfaces = (table) => {
  os.networkInterfaces = () => table;
};

let passed = 0;
let failed = 0;
function test(title, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${title}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${title}\n      ${err?.message ?? err}`);
  }
}
function group(title) {
  console.log(`\n${title}`);
}

// ───────────────────────── 地址分类 ─────────────────────────

group("地址分类 ipv4Scope()");

test("RFC1918 三段都识别", () => {
  assert.equal(ipv4Scope("10.0.0.5"), "rfc1918");
  assert.equal(ipv4Scope("172.16.0.1"), "rfc1918");
  assert.equal(ipv4Scope("172.31.255.254"), "rfc1918");
  assert.equal(ipv4Scope("192.168.1.10"), "rfc1918");
});

test("172.32 不算 RFC1918（/12 边界）", () => {
  assert.equal(ipv4Scope("172.32.0.1"), "other");
  assert.equal(ipv4Scope("172.15.255.255"), "other");
});

test("100.64.0.0/10 识别为 cgnat", () => {
  assert.equal(ipv4Scope("100.64.7.1"), "cgnat");
  assert.equal(ipv4Scope("100.64.7.2"), "cgnat");
  assert.equal(ipv4Scope("100.100.1.7"), "cgnat");
  assert.equal(ipv4Scope("100.127.255.254"), "cgnat");
  assert.equal(isCgnatIPv4("100.64.7.5"), true);
});

test("100.63 / 100.128 不算 cgnat（/10 边界）", () => {
  assert.equal(ipv4Scope("100.63.255.255"), "other");
  assert.equal(ipv4Scope("100.128.0.1"), "other");
});

test("链路本地、回环、非法值", () => {
  assert.equal(ipv4Scope("169.254.1.1"), "linklocal");
  assert.equal(ipv4Scope("127.0.0.1"), "loopback");
  assert.equal(ipv4Scope("8.8.8.8"), "other");
  assert.equal(ipv4Scope("not-an-ip"), "invalid");
  assert.equal(ipv4Scope("1.2.3"), "invalid");
  assert.equal(ipv4Scope("256.1.1.1"), "invalid");
});

test("isPrivateIPv4 覆盖 RFC1918 + CGNAT + 链路本地", () => {
  assert.equal(isPrivateIPv4("192.168.1.1"), true);
  assert.equal(isPrivateIPv4("100.64.7.1"), true);
  assert.equal(isPrivateIPv4("169.254.1.1"), true);
  assert.equal(isPrivateIPv4("8.8.8.8"), false);
});

group("地址归一化 normalizeIPv4()");

test("剥掉 IPv6 映射前缀与端口", () => {
  assert.equal(normalizeIPv4("::ffff:192.168.1.5"), "192.168.1.5");
  assert.equal(normalizeIPv4("::ffff:100.64.7.5"), "100.64.7.5");
  assert.equal(normalizeIPv4("192.168.1.5:45917"), "192.168.1.5");
  assert.equal(normalizeIPv4("  192.168.1.5  "), "192.168.1.5");
  assert.equal(normalizeIPv4(""), "");
  assert.equal(normalizeIPv4("::1"), "");
  assert.equal(normalizeIPv4(undefined), "");
});

// ───────────────────────── 选对外地址 ─────────────────────────

group("preferredAddress() 在 CGNAT / Tailscale 场景下");

test("只有 Tailscale 时用 100.64 地址（不是 127.0.0.1）", () => {
  useIfaces({ tailscale0: iface("100.64.7.5") });
  assert.equal(preferredAddress(), "100.64.7.5");
  assert.deepEqual(hostCandidates(), ["100.64.7.5"]);
});

test("物理网卡 + Tailscale：优先物理内网", () => {
  useIfaces({ lo: loopback(), tailscale0: iface("100.64.7.5"), eth0: iface("192.168.1.10") });
  assert.equal(preferredAddress(), "192.168.1.10");
  assert.deepEqual(hostCandidates(), ["192.168.1.10", "100.64.7.5"]);
});

test("Windows 中文网卡名：与枚举顺序无关", () => {
  useIfaces({ 以太网: iface("192.168.1.10"), Tailscale: iface("100.64.7.5") });
  const a = preferredAddress();
  useIfaces({ Tailscale: iface("100.64.7.5"), 以太网: iface("192.168.1.10") });
  const b = preferredAddress();
  assert.equal(a, "192.168.1.10", "第一次顺序应挑物理网卡");
  assert.equal(b, "192.168.1.10", "反过来也必须挑物理网卡");
  assert.equal(a, b);
});

test("docker0 不会抢过物理网卡", () => {
  useIfaces({ docker0: iface("172.17.0.1"), eth0: iface("192.168.1.10") });
  assert.equal(preferredAddress(), "192.168.1.10");
});

test("CGNAT 排在公网地址之前", () => {
  useIfaces({ eth0: iface("203.0.113.7"), tailscale0: iface("100.64.7.5") });
  assert.equal(preferredAddress(), "100.64.7.5");
});

test("announceAddress 能把广播地址钉住", () => {
  useIfaces({ eth0: iface("192.168.1.10"), tailscale0: iface("100.64.7.5") });
  assert.equal(preferredAddress("100.64.7.5"), "100.64.7.5");
  assert.deepEqual(hostCandidates("100.64.7.5"), ["100.64.7.5", "192.168.1.10"]);
});

test("没有可用网卡时退回回环", () => {
  useIfaces({});
  assert.equal(preferredAddress(), "127.0.0.1");
});

test("orderedLanAddresses 带 scope 标注且不含回环", () => {
  useIfaces({ lo: loopback(), eth0: iface("192.168.1.10"), tailscale0: iface("100.64.7.5") });
  const all = orderedLanAddresses();
  assert.equal(all.length, 2);
  assert.equal(all[0].scope, "rfc1918");
  assert.equal(all[1].scope, "cgnat");
});

// ───────────────────────── 扫描计划 ─────────────────────────

group("resolveScanPlan() —— scanRanges 静默失效的修复");

test("不配 scanRanges 时扫本机 /24", () => {
  useIfaces({ eth0: iface("192.168.1.10") });
  const plan = resolveScanPlan([]);
  assert.equal(plan.addresses.length, 254);
  assert.equal(plan.addresses[0], "192.168.1.1");
  assert.equal(plan.addresses.includes("192.168.1.10"), true, "同机多实例要能扫到自己");
  assert.deepEqual(plan.warnings, []);
});

test("100.64.0.0/10 不再被静默丢掉（旧版这里返回 0 个地址）", () => {
  useIfaces({ eth0: iface("192.168.1.10") });
  const plan = resolveScanPlan(["100.64.0.0/10"]);
  assert.ok(plan.addresses.length > 0, "必须真的扫到地址");
  assert.ok(plan.addresses.some((ip) => ip.startsWith("100.64.")), "要包含 CGNAT 网段");
  assert.ok(plan.addresses.some((ip) => ip.startsWith("192.168.1.")), "本机 /24 不能因为配了 scanRanges 就被跳过");
  assert.equal(plan.warnings.length > 0, true, "被预算截断必须告警");
  assert.match(plan.warnings.join("\n"), /超出本次预算/);
});

test("配了 scanRanges 仍然扫本机 /24（叠加而非替换）", () => {
  useIfaces({ eth0: iface("192.168.1.10") });
  const plan = resolveScanPlan(["192.168.50.0/24"]);
  assert.ok(plan.addresses.includes("192.168.50.1"));
  assert.ok(plan.addresses.includes("192.168.1.1"));
});

test("非法网段被忽略但会告警，本机 /24 照常扫", () => {
  useIfaces({ eth0: iface("192.168.1.10") });
  const plan = resolveScanPlan(["192.168.1.0/33", "garbage", "1.2.3"]);
  assert.equal(plan.warnings.length, 3);
  assert.match(plan.warnings.join("\n"), /被忽略/);
  assert.ok(plan.addresses.includes("192.168.1.1"), "本机 /24 兜底必须还在");
});

test("/8~/32 都接受，/7 拒绝", () => {
  useIfaces({ eth0: iface("192.168.1.10") });
  assert.ok(resolveScanPlan(["10.0.0.0/8"]).addresses.length > 0);
  assert.ok(resolveScanPlan(["100.64.0.0/16"]).addresses.length > 0);
  assert.match(resolveScanPlan(["10.0.0.0/7"]).warnings.join("\n"), /前缀长度只支持/);
});

test("scanMaxAddresses 预算生效", () => {
  useIfaces({ eth0: iface("192.168.1.10") });
  const plan = resolveScanPlan(["10.0.0.0/8"], 300);
  assert.equal(plan.addresses.length, 300);
  assert.ok(plan.warnings.length > 0);
});

test("只有 Tailscale 的机器会扫自己的 100.64 网段", () => {
  useIfaces({ tailscale0: iface("100.64.7.9") });
  const plan = resolveScanPlan([]);
  assert.equal(plan.addresses.length, 254);
  assert.ok(plan.addresses.every((ip) => ip.startsWith("100.64.7.")));
});

test("candidateAddresses 与 resolveScanPlan 一致", () => {
  useIfaces({ eth0: iface("192.168.1.10") });
  assert.deepEqual(candidateAddresses(["100.64.0.0/24"]), resolveScanPlan(["100.64.0.0/24"]).addresses);
});

// ───────────────────────── 对端候选地址 ─────────────────────────

group("peerHosts() —— 回连不再只信对端自述");

test("实测地址排在对端自述地址之前", () => {
  const hosts = peerHosts({ host: "192.168.1.99", hosts: ["192.168.1.99"], sourceAddress: "100.64.7.9" });
  assert.deepEqual(hosts, ["100.64.7.9", "192.168.1.99"]);
});

test("老版本对端只发 host 时也能用", () => {
  assert.deepEqual(peerHosts({ host: "192.168.1.5" }), ["192.168.1.5"]);
});

test("去重、剔除非法项、归一化", () => {
  const hosts = peerHosts({
    host: "::ffff:192.168.1.5",
    hosts: ["192.168.1.5", "192.168.1.5", "bogus", "100.64.7.9"],
    sourceAddress: "",
  });
  assert.deepEqual(hosts, ["192.168.1.5", "100.64.7.9"]);
});

// ───────────────────────── 发现注册表 ─────────────────────────

group("MeshDiscovery 的 hosts / markReachable");

test("心跳自带全部候选地址", () => {
  useIfaces({ eth0: iface("192.168.1.10"), tailscale0: iface("100.64.7.5") });
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  const rec = d.selfRecord();
  assert.equal(rec.host, "192.168.1.10");
  assert.deepEqual(rec.hosts, ["192.168.1.10", "100.64.7.5"]);
});

test("note() 保留实测来源地址，不被自述地址覆盖", () => {
  useIfaces({ eth0: iface("192.168.1.10"), tailscale0: iface("100.64.7.5") });
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "peer-1", machine: "peer", host: "192.168.1.99", hosts: ["192.168.1.99"], port: 45917 }, "100.64.7.9");
  const p = d.peers()[0];
  assert.equal(p.host, "192.168.1.99", "首选仍是对端自述");
  assert.equal(p.sourceAddress, "100.64.7.9", "sourceAddress 必须是实测地址");
  assert.deepEqual(peerHosts(p), ["100.64.7.9", "192.168.1.99"]);
});

test("markReachable 把实测连上的地址提到最前并自愈", () => {
  useIfaces({ eth0: iface("192.168.1.10") });
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  d.note({ app: "dsh-mesh", id: "peer-1", machine: "peer", host: "192.168.1.99", hosts: ["192.168.1.99", "100.64.7.9"], port: 45917 }, "100.64.7.9");
  const changed = d.markReachable("peer-1", "100.64.7.9");
  const p = d.peers()[0];
  assert.equal(changed, true);
  assert.equal(p.host, "100.64.7.9", "首选应切换到实测可达的地址");
  assert.equal(p.sourceAddress, "100.64.7.9");
  assert.equal(peerHosts(p)[0], "100.64.7.9");
});

test("note() 拒绝自己 / 非本协议报文", () => {
  useIfaces({ eth0: iface("192.168.1.10") });
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  assert.equal(d.note({ app: "dsh-mesh", id: "self-1", host: "192.168.1.10" }, "192.168.1.10"), false);
  assert.equal(d.note({ app: "other", id: "peer-1", host: "192.168.1.10" }, "192.168.1.10"), false);
  assert.equal(d.peers().length, 0);
});

test("hosts 数组来自外部输入，限长防滥用", () => {
  useIfaces({ eth0: iface("192.168.1.10") });
  const d = new MeshDiscovery({ id: "self-1", port: 45917, meta: { machine: "me" } });
  const many = Array.from({ length: 100 }, (_, i) => `10.0.${i}.1`);
  d.note({ app: "dsh-mesh", id: "peer-1", machine: "peer", host: "10.0.0.1", hosts: many, port: 45917 }, "10.0.0.1");
  assert.ok(d.peers()[0].hosts.length <= 16, `hosts 应被限制长度，实际 ${d.peers()[0].hosts.length}`);
});

// ───────────────────────── 收尾 ─────────────────────────

os.networkInterfaces = realNetworkInterfaces;
console.log(`\n${failed === 0 ? "✅" : "❌"} 通过 ${passed} / ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
