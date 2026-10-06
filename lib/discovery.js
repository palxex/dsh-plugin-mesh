/**
 * Mesh 发现模块：局域网内自动发现其他 DSH 实例。
 *
 * 用自建的 UDP 组播心跳，而不是 mDNS/Bonjour —— 理由：
 *   · 零依赖（只用 node:dgram），跨平台行为一致
 *   · 完全可控：报文格式、过期策略、多网卡处理都由我们决定
 *   · 我们只需要 DSH↔DSH 互相发现，不需要和 Bonjour 互操作
 *
 * 协议：每 5 秒向 239.255.42.99:45892 发一个 JSON 心跳，同时监听该组播组。
 *   超过 ttlMs 没心跳 → 标记 offline（仍保留在列表里，用户要看到"有这台机器"）
 *   超过 keepMs 没心跳 → 丢弃
 *
 * 安全：发现是完全公开的（局域网内谁都能看见谁），这是有意设计 ——
 *       先让你看见机器，再决定要不要和它配对。真正的操作要过 token。
 *
 * 地址模型（2026-10 改）：本机把**所有**候选地址都塞进心跳的 hosts 数组，
 *   对端按 sourceAddress → hosts → host 的顺序逐个尝试连接。
 *   因为"哪张网卡能连上"在两端视角不同：同一台机器可能同时有物理内网
 *   192.168.x 和 Tailscale 的 100.64.x，只有实际收到心跳的那条路才必然可达。
 */
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import os from "node:os";

export const MESH_GROUP = "239.255.42.99";
export const MESH_PORT = 45892;
export const APP_TAG = "dsh-mesh";
export const PROTOCOL_VERSION = 1;

// ───────────────────────── 地址分类 ─────────────────────────
//
// 为什么要有这一层：旧版只用网卡名（en0/eth0/wlan0…）挑"对外地址"，而
// 100.64.0.0/10（RFC 6598 CGNAT）既不是 RFC1918、网卡名也不叫 eth*，
// 于是被当成"未知网卡"和别的网卡并列，谁先谁后取决于 os.networkInterfaces()
// 的枚举顺序 —— Windows 上中文网卡名（"以太网"）压根匹配不上正则，
// 同一台机器换个顺序就会广播出不同的地址。
//
// 现在把"地址属于哪类私网"变成一等公民，网卡名只作次级权重。

/** 解析 a.b.c.d → 32 位无符号整数；不是合法 IPv4 返回 null。 */
function ipv4ToInt(address) {
  const parts = String(address ?? "").trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n * 256 + v) >>> 0;
  }
  return n;
}

/**
 * 去掉 IPv6 映射前缀（::ffff:192.168.1.5）、方括号和端口，返回纯 IPv4 或空串。
 * Node 在双栈 socket 上给出的 remoteAddress 常常带 ::ffff: 前缀，
 * 直接拿去拼 URL 会变成 http://::ffff:1.2.3.4:45917/ —— 必须归一化。
 */
export function normalizeIPv4(value) {
  let s = String(value ?? "").trim();
  if (!s) return "";
  s = s.replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?$/.exec(s);
  if (!m) return "";
  return ipv4ToInt(m[1]) === null ? "" : m[1];
}

/**
 * IPv4 属于哪一类可达地址：
 *   · "rfc1918"    10/8、172.16/12、192.168/16 —— 传统家庭/公司内网
 *   · "cgnat"      100.64/10 —— RFC 6598，Tailscale / headscale / 运营商级 NAT
 *   · "linklocal"  169.254/16 —— 没有 DHCP 时的自动地址
 *   · "loopback"   127/8
 *   · "other"      其余（公网地址、Docker 默认桥 172.17 已含在 rfc1918 里）
 *   · "invalid"    不是合法 IPv4
 */
export function ipv4Scope(address) {
  const n = ipv4ToInt(address);
  if (n === null) return "invalid";
  // 注意 `n & mask` 在 JS 里返回**有符号** int32：0xc0a80000 会变成负数，
  // 所以每个掩码结果都要 >>> 0 转回无符号再比较。
  const inNet = (mask, net) => ((n & mask) >>> 0) === net;
  if (inNet(0xff000000, 0x7f000000)) return "loopback"; // 127/8
  if (inNet(0xff000000, 0x0a000000)) return "rfc1918"; // 10/8
  if (inNet(0xfff00000, 0xac100000)) return "rfc1918"; // 172.16/12
  if (inNet(0xffff0000, 0xc0a80000)) return "rfc1918"; // 192.168/16
  if (inNet(0xffc00000, 0x64400000)) return "cgnat"; // 100.64/10
  if (inNet(0xffff0000, 0xa9fe0000)) return "linklocal"; // 169.254/16
  return "other";
}

/** 是否 100.64.0.0/10（RFC 6598 CGNAT —— Tailscale / headscale 用的就是这段）。 */
export function isCgnatIPv4(address) {
  return ipv4Scope(address) === "cgnat";
}

/** 是否"私网/隧道"地址：RFC1918 + CGNAT + 链路本地。 */
export function isPrivateIPv4(address) {
  const s = ipv4Scope(address);
  return s === "rfc1918" || s === "cgnat" || s === "linklocal";
}

/** 虚拟/容器网桥：这些地址几乎不可能被别的机器连上，直接垫底。 */
function isVirtualIface(name) {
  return /^(bridge|vmnet|docker|veth|virbr|br[-_]|lxc|lo\d*$)/i.test(name);
}

/** 网卡名的"像不像物理网卡"打分，越小越优先。 */
function ifaceNameScore(name) {
  if (isVirtualIface(name)) return 9;
  if (/^(en0|en1|eth0|wlan0|Wi-?Fi)$/i.test(name)) return 0;
  if (/^(en|eth|wlan|wl)/i.test(name)) return 1;
  // 隧道 / 覆盖网（Tailscale、WireGuard、ZeroTier、nebula…）：
  // 承载的通常是 100.64/10 或私有段，能通，但不是"直连"，排中间。
  if (/^(tailscale|wg|zt|nebula|utun|tun|tap|ppp|ipsec)/i.test(name)) return 4;
  return 5;
}

/** 地址类别的打分：私网优先，公网其次，链路本地最后。 */
function scopeScore(scope) {
  if (scope === "rfc1918") return 0;
  if (scope === "cgnat") return 1;
  if (scope === "other") return 2;
  if (scope === "linklocal") return 3;
  return 4;
}

/**
 * 列出本机所有可供局域网访问的 IPv4 地址（排除回环），带地址类别标注。
 * 注意这里**不按地址段过滤** —— 任何非回环 IPv4 都可能是对端唯一能连上的那条路
 * （例如只有 Tailscale 的机器就只有 100.64.x），过滤掉等于把它变成聋子。
 */
export function lanIPv4Addresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const address = normalizeIPv4(a.address);
      if (!address) continue;
      const scope = ipv4Scope(address);
      if (scope === "loopback") continue;
      out.push({ iface: name, address, mac: a.mac ?? "", scope });
    }
  }
  return out;
}

/** 本机候选地址，按"最可能被对端连上"排序（稳定、与枚举顺序无关）。 */
export function orderedLanAddresses() {
  return lanIPv4Addresses()
    .map((entry, index) => {
      const score =
        (isVirtualIface(entry.iface) ? 100 : 0) + scopeScore(entry.scope) * 10 + ifaceNameScore(entry.iface);
      return { entry, index, score };
    })
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((x) => x.entry);
}

/** 找到承载指定 IPv4 的接口 MAC；找不到返回空串。 */
export function macForAddress(address) {
  const want = normalizeIPv4(address);
  if (!want) return "";
  for (const { address: addr, mac } of lanIPv4Addresses()) {
    if (addr === want) return mac;
  }
  return "";
}

/**
 * 挑一个最可能被对端访问到的地址。
 * 排序依据：虚拟网桥垫底 → 地址类别（RFC1918 > CGNAT > 公网 > 链路本地）→ 物理网卡名。
 * 传了 override（配置里的 announceAddress）就用它，用来手动钉住广播地址。
 */
export function preferredAddress(override = "") {
  const pinned = normalizeIPv4(override);
  if (pinned) return pinned;
  return orderedLanAddresses()[0]?.address ?? "127.0.0.1";
}

/** 本机所有候选地址（有序），心跳里的 hosts 就是它。 */
export function hostCandidates(override = "") {
  const hosts = orderedLanAddresses().map((a) => a.address);
  const pinned = normalizeIPv4(override);
  if (!pinned) return hosts;
  return [pinned, ...hosts.filter((h) => h !== pinned)];
}

/**
 * 一个对端的全部候选地址，按"最可能连得上"排序：
 *   1. sourceAddress —— 我们实际观察到它的地址（组播来源 IP / 扫描命中的 IP），已被证明可达
 *   2. hosts         —— 它自述的地址列表（新版心跳带这个）
 *   3. host          —— 它自述的首选地址（老版本只发这一个）
 */
export function peerHosts(peer) {
  if (!peer) return [];
  const out = [];
  const push = (h) => {
    const v = normalizeIPv4(h);
    if (v && !out.includes(v)) out.push(v);
  };
  push(peer.sourceAddress);
  for (const h of peer.hosts ?? []) push(h);
  push(peer.host);
  return out;
}

/** 归一化心跳里的 hosts 数组（去重、剔非法项、限长）。 */
function normalizeHostList(value) {
  const raw = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of raw) {
    const v = normalizeIPv4(item);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= 16) break; // 防御：心跳是外部输入
  }
  return out;
}

/**
 * 组播发现。事件：
 *   "change"       —— 对端列表有任何变化（新增/离线/恢复/信息更新）
 *   "diagnostic"   —— 网络层问题（非致命），参数为字符串
 */
export class MeshDiscovery extends EventEmitter {
  #id;
  #port;
  #meta;
  #intervalMs;
  #ttlMs;
  #keepMs;
  #peers = new Map();
  #socket = null;
  #announceTimer = null;
  #sweepTimer = null;
  #started = false;
  #multicast = true;
  #address;
  #announceAddress = "";

  constructor({ id, port, meta = {}, intervalMs = 5000, ttlMs = 20000, keepMs = 300000, announceAddress = "" }) {
    super();
    this.#id = id;
    this.#port = port;
    this.#meta = meta;
    this.#intervalMs = intervalMs;
    this.#ttlMs = ttlMs;
    this.#keepMs = keepMs;
    this.#announceAddress = normalizeIPv4(announceAddress);
    this.#address = preferredAddress(this.#announceAddress);
  }

  get instanceId() {
    return this.#id;
  }

  get address() {
    return this.#address;
  }

  /** 本机当前会广播出去的全部候选地址（有序）。 */
  get hosts() {
    return hostCandidates(this.#announceAddress);
  }

  /**
   * 手动钉住广播地址（配置里的 announceAddress，或页面上的选择）。
   * 传空串恢复自动挑选。会立刻重新广播一次。
   */
  setAnnounceAddress(address) {
    this.#announceAddress = normalizeIPv4(address);
    this.#address = preferredAddress(this.#announceAddress);
    if (this.#started) this.#announce();
    return this.#address;
  }

  get announceAddress() {
    return this.#announceAddress;
  }

  /**
   * 回填真实的监听端口。
   * HTTP 服务通常绑 0（随机端口），要等它 listening 之后才知道端口号，
   * 所以发现模块允许在 start() 之前或之后设置。
   */
  setPort(port) {
    this.#port = Number(port) || 0;
    if (this.#started) this.#announce(); // 端口变了，立刻重新广播一次
    return this;
  }

  get port() {
    return this.#port;
  }

  /**
   * 改本机在对端列表里显示的名字。
   * 立即重新广播一次，对端不用等下一个心跳周期就能看到新名字。
   * @returns 旧名字
   */
  setMachine(name) {
    const previous = this.#meta.machine;
    this.#meta.machine = String(name);
    if (this.#started) this.#announce();
    return previous;
  }

  /**
   * 本机对外名片。
   *
   * 这里每次都重新探测一次对外地址，而不是复用启动时缓存 ——
   * 网络切换（换 WiFi / 热点 / 插网线）后 #address 会过时，导致心跳里广播旧 IP，
   * 别的机器用旧 IP 连不上。广播每 5s 一次，所以切网后最多 5s 就能自愈。
   * mac 也跟着用新地址现算，避免"旧 IP 找不到对应网卡 → mac 变空"。
   *
   * hosts 是**全部**候选地址（首选在前）。对端只认 host 时行为与旧版一致，
   * 认 hosts 时就能在首选地址不通的情况下自动换一条路。
   */
  selfRecord() {
    const hosts = hostCandidates(this.#announceAddress);
    this.#address = hosts[0] ?? "127.0.0.1";
    return {
      v: PROTOCOL_VERSION,
      app: APP_TAG,
      id: this.#id,
      machine: this.#meta.machine ?? os.hostname(),
      hostname: os.hostname(),
      mac: macForAddress(this.#address),
      host: this.#address,
      hosts,
      port: this.#port,
      os: `${os.platform()} ${os.release()}`,
      user: this.#meta.user ?? os.userInfo().username,
      profile: this.#meta.profile ?? "",
      version: this.#meta.version ?? "",
      ts: Date.now(),
    };
  }

  /**
   * 启动发现。
   * @param options.multicast 是否启用 UDP 组播。关掉它只影响"被动发现"，
   *   过期清理（sweep）照常运行 —— 因为主动扫描 / ping 也会往注册表里写对端，
   *   它们同样需要被标记离线。这个解耦是必须的，否则关掉组播后对端永不过期。
   */
  start({ multicast = true } = {}) {
    if (this.#started) return this;
    this.#started = true;
    this.#multicast = multicast;

    // 过期清理：与组播无关，始终运行
    this.#sweepTimer = setInterval(() => this.#sweep(), Math.max(2000, Math.floor(this.#ttlMs / 4)));
    this.#sweepTimer.unref?.();

    if (!multicast) return this;

    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.#socket = socket;

    socket.on("error", (err) => {
      this.emit("diagnostic", `discovery socket error: ${err.message}`);
    });

    socket.on("message", (buf, rinfo) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString("utf8"));
      } catch {
        return; // 不是我们的报文，忽略
      }
      if (!msg || msg.app !== APP_TAG) return;
      if (msg.id === this.#id) return; // 自己发的
      this.#upsert(msg, rinfo);
    });

    socket.on("listening", () => {
      try {
        socket.setMulticastTTL(1); // 只在本网段
        socket.setMulticastLoopback(true); // 同机多实例也能互相看见（便于调试）
        socket.addMembership(MESH_GROUP);
      } catch (err) {
        this.emit("diagnostic", `join multicast failed: ${err.message}`);
      }
      this.#announce();
    });

    try {
      socket.bind(MESH_PORT);
    } catch (err) {
      this.emit("diagnostic", `bind ${MESH_PORT} failed: ${err.message}`);
    }

    this.#announceTimer = setInterval(() => this.#announce(), this.#intervalMs);
    this.#announceTimer.unref?.();

    return this;
  }

  stop() {
    if (!this.#started) return;
    this.#started = false;
    if (this.#announceTimer) clearInterval(this.#announceTimer);
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#announceTimer = this.#sweepTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      try {
        socket.dropMembership(MESH_GROUP);
      } catch {
        /* 已经关闭 */
      }
      try {
        socket.close();
      } catch {
        /* 已经关闭 */
      }
    }
  }

  /** 立刻广播一次（配对/刷新时用）。 */
  announceNow() {
    this.#announce();
  }

  /** 当前对端快照，按 machine 名排序。 */
  peers() {
    return [...this.#peers.values()]
      .map((p) => ({ ...p, online: p.online }))
      .sort((a, b) => String(a.machine).localeCompare(String(b.machine)) || String(a.id).localeCompare(String(b.id)));
  }

  get(id) {
    return this.#peers.get(id);
  }

  /**
   * 从外部来源登记一个对端（主动扫描命中、或 ping 到已知对端）。
   * 复用与组播心跳完全一样的记录结构，所以两条发现路径天然一致。
   * @param record 对方 /mesh/v1/health 返回的自述记录
   * @param sourceAddress 实际观察到它的 IP（连接时优先于自述地址）
   * @returns 是否造成可见变化
   */
  note(record, sourceAddress) {
    if (!record || record.app !== APP_TAG || !record.id || record.id === this.#id) return false;
    const address = normalizeIPv4(sourceAddress) || normalizeIPv4(record.host);

    // 同一个来源地址上出现了**另一个实例** → 旧实例已经死了（对端重启会换 instanceId）。
    //
    // 不清掉的话它会变成僵尸：pingKnownPeers 是按地址探活的，探到的是新实例，
    // 却会顺手把旧记录也标成 online + 刷新 lastSeen，于是旧记录永远不过期。
    // 结果同名对端越积越多，mesh_run --peer <名字> 直接报
    // "名字 xxx 同时匹配到 N 台机器"，按名字派发彻底不可用。
    let dropped = false;
    if (address) {
      for (const [id, peer] of this.#peers) {
        if (id !== record.id && peer.sourceAddress === address) {
          this.#peers.delete(id);
          dropped = true;
        }
      }
    }

    const changed = this.#upsert(record, { address: address || "?" });
    return changed || dropped;
  }

  /** 把某对端标记为已确认可达（ping 成功），刷新 lastSeen。 */
  touch(id, sourceAddress) {
    const p = this.#peers.get(id);
    if (!p) return;
    const wasOffline = !p.online;
    p.lastSeen = Date.now();
    p.online = true;
    const host = normalizeIPv4(sourceAddress);
    if (host) p.sourceAddress = host;
    if (wasOffline) this.emit("change", this.peers());
  }

  /**
   * 记下"这个地址真的连上了"，把它提到候选列表最前。
   *
   * 为什么需要：对端自述的首选地址可能已经不通（它换了网 / 新开了 Tailscale，
   * 而它自己不知道我们是从哪条路过来的）。只信自述地址会让"明明连得上"变成连不上。
   * 这里用的是**我们亲自验证过**的地址，所以也顺手刷新 sourceAddress。
   * @returns 是否造成可见变化
   */
  markReachable(id, address) {
    const p = this.#peers.get(id);
    const host = normalizeIPv4(address);
    if (!p || !host) return false;
    const rest = [];
    for (const h of [p.host, ...(p.hosts ?? []), p.sourceAddress]) {
      const v = normalizeIPv4(h);
      if (v && v !== host && !rest.includes(v)) rest.push(v);
    }
    const changed = p.host !== host;
    p.host = host;
    p.hosts = [host, ...rest];
    p.sourceAddress = host;
    p.lastSeen = Date.now();
    p.online = true;
    if (changed) this.emit("change", this.peers());
    return changed;
  }

  #announce() {
    const socket = this.#socket;
    if (!socket || !this.#multicast) return;
    const payload = Buffer.from(JSON.stringify(this.selfRecord()), "utf8");
    socket.send(payload, 0, payload.length, MESH_PORT, MESH_GROUP, (err) => {
      if (err) this.emit("diagnostic", `announce failed: ${err.message}`);
    });
  }

  #upsert(msg, rinfo) {
    const id = String(msg.id);
    const now = Date.now();
    const prev = this.#peers.get(id);

    // 候选地址：优先用对端自述的 hosts（它自己排的序），退回到单个 host，
    // 再退回我们实际看到它的来源 IP。注意这里**不覆盖** sourceAddress ——
    // 它是"我们实测到的地址"，回连时排在最前，和自述地址是两回事。
    const advertised = normalizeHostList(msg.hosts);
    const primary = normalizeIPv4(msg.host);
    const observed = normalizeIPv4(rinfo?.address);
    const hosts = [];
    for (const h of [...advertised, primary]) {
      if (h && !hosts.includes(h)) hosts.push(h);
    }
    if (hosts.length === 0 && observed) hosts.push(observed);

    const next = {
      id,
      machine: String(msg.machine ?? "unknown"),
      hostname: String(msg.hostname ?? ""),
      mac: String(msg.mac ?? ""),
      host: hosts[0] ?? "?",
      hosts,
      sourceAddress: observed,
      port: Number(msg.port) || 0,
      os: String(msg.os ?? ""),
      user: String(msg.user ?? ""),
      profile: String(msg.profile ?? ""),
      version: String(msg.version ?? ""),
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      online: true,
    };
    const changed =
      !prev ||
      !prev.online ||
      prev.machine !== next.machine ||
      prev.host !== next.host ||
      prev.port !== next.port ||
      prev.profile !== next.profile ||
      (prev.hosts ?? []).join(",") !== next.hosts.join(",");
    this.#peers.set(id, next);
    if (changed) this.emit("change", this.peers());
    return changed;
  }

  #sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.#peers) {
      if (now - p.lastSeen > this.#keepMs) {
        this.#peers.delete(id);
        changed = true;
      } else if (p.online && now - p.lastSeen > this.#ttlMs) {
        p.online = false;
        changed = true;
      }
    }
    if (changed) this.emit("change", this.peers());
  }
}
