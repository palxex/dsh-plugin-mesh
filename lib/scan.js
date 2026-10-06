/**
 * 主动扫描：直接扫本网段的固定端口，靠一次 HTTP ping 建立连接。
 *
 * 为什么需要它 —— 组播不是万能的：
 *   · 很多路由器/AP 的 AP isolation 会隔离客户端之间的组播
 *   · Windows 防火墙默认拦入站组播，很容易被忽略
 *   · 跨 VLAN / 子网时组播根本不走
 *   · Tailscale / WireGuard 这类覆盖网**完全不承载组播**，只有 TCP 能过
 * 而"TCP 直连固定端口"只要网络通就能成，所以它是更可靠的那条路。
 *
 * 两者是互补的：组播负责"零配置即时发现"，扫描负责"组播被挡时也能找到"。
 */
import { orderedLanAddresses } from "./discovery.js";

/** 单次扫描的默认地址预算。调大要自己承担耗时（每 64 并发约 1 秒 / 64 个地址）。 */
export const DEFAULT_SCAN_LIMIT = 1024;

/** 网段展开的最小前缀长度。/8 以下（含 /8）在预算内只可能是采样，没有意义。 */
const MIN_PREFIX_BITS = 8;

/**
 * 展开一个 a.b.c.d/nn 网段。
 *
 * 旧版只支持 /16~/32，于是 Tailscale 的 100.64.0.0/10 被**静默**丢掉：
 * expandCidr 返回空数组，而 candidateAddresses 又因为"用户配了 scanRanges"
 * 跳过了 /24 兜底，最后扫 0 个地址、也没有任何提示。现在放到 /8，并且
 * 把"为什么被拒"和"被预算截断了多少"都带出去。
 *
 * @returns {{ips: string[], size: number, truncated: boolean, error: string}}
 */
function expandCidr(cidr, cap) {
  const raw = String(cidr ?? "").trim();
  const [base, bitsRaw] = raw.split("/");
  const bits = bitsRaw === undefined || bitsRaw === "" ? 24 : Number(bitsRaw);
  const parts = String(base ?? "").split(".").map(Number);

  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return { ips: [], size: 0, truncated: false, error: `不是合法的 IPv4 网段` };
  }
  if (!Number.isInteger(bits) || bits < MIN_PREFIX_BITS || bits > 32) {
    return { ips: [], size: 0, truncated: false, error: `前缀长度只支持 /${MIN_PREFIX_BITS}~/32` };
  }

  const baseNum = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const size = 2 ** (32 - bits);
  const take = Math.min(size, Math.max(1, cap));
  const ips = [];
  for (let i = 0; i < take; i += 1) {
    const n = (baseNum + i) >>> 0;
    ips.push(`${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
  }
  return { ips, size, truncated: size > take, error: "" };
}

/**
 * 算出这次扫描要打哪些地址，并把"为什么这么打"一并返回，供日志/UI 提示。
 *
 * 两条来源**叠加**（配置项名字就叫"额外网段"）：
 *   1. 本机每张网卡所在 /24 —— 命中率最高，永远会扫
 *   2. config.scanRanges 里配的网段 —— 追加
 * 旧版是"配了 scanRanges 就不扫本机 /24"，一个手滑的网段就能让发现彻底失效。
 *
 * @returns {{addresses: string[], ranges: Array, warnings: string[]}}
 */
export function resolveScanPlan(extraRanges = [], limit = DEFAULT_SCAN_LIMIT) {
  const max = Math.max(1, Number(limit) || DEFAULT_SCAN_LIMIT);
  const warnings = [];
  const ranges = [];
  const seen = new Set();
  const addresses = [];
  const push = (ip) => {
    if (seen.has(ip) || addresses.length >= max) return;
    seen.add(ip);
    addresses.push(ip);
  };

  // 1) 本机所在 /24
  //
  // 注意：这里**不排除本机 IP**。因为同机跑多个实例时它们共用一个 IP，
  // 排掉就永远发现不了彼此；而扫到自己也无害 —— discovery.note() 会按
  // 实例 id 把自身拒掉。
  for (const { address, iface, scope } of orderedLanAddresses()) {
    const prefix = address.slice(0, address.lastIndexOf("."));
    const before = addresses.length;
    for (let host = 1; host <= 254; host += 1) push(`${prefix}.${host}`);
    ranges.push({
      range: `${prefix}.0/24`,
      source: "本机网卡",
      iface,
      scope,
      size: 254,
      count: addresses.length - before,
      truncated: false,
      error: "",
    });
  }

  // 2) 用户追加的网段
  for (const range of extraRanges) {
    const { ips, size, truncated, error } = expandCidr(range, max);
    const before = addresses.length;
    for (const ip of ips) push(ip);
    const count = addresses.length - before;
    ranges.push({
      range: String(range),
      source: "scanRanges",
      size,
      count,
      truncated: truncated || count < ips.length,
      error,
    });
    if (error) {
      warnings.push(`scanRanges 里的 "${range}" 被忽略：${error}`);
      continue;
    }
    if (count === 0) {
      warnings.push(`网段 ${range} 没有扫到任何地址（本次扫描预算 ${max} 已被本机 /24 用满）。`);
      continue;
    }
    if (truncated) {
      warnings.push(
        `网段 ${range} 共 ${size} 个地址，超出本次预算 ${max}，实际只扫了 ${count} 个。` +
          `建议改配更小的网段（如若干个 /24），或调大 scanMaxAddresses。`,
      );
    }
  }

  if (addresses.length >= max) {
    warnings.push(`本次扫描地址数已达预算上限 ${max}（scanMaxAddresses），超出部分被截断。`);
  }

  return { addresses, ranges, warnings };
}

/**
 * 由本机网卡推导出候选地址列表。
 * @param extraRanges 额外网段，如 ["192.168.1.0/24"]、["100.64.0.0/24"]；本机 /24 始终会扫
 * @param limit 最多返回多少个候选（防止超大网段扫太久）
 */
export function candidateAddresses(extraRanges = [], limit = DEFAULT_SCAN_LIMIT) {
  return resolveScanPlan(extraRanges, limit).addresses;
}

/**
 * 并发探测一批地址（可跨多个端口）的 mesh 服务。
 * @param ports 要探测的端口数组；通常就是本机端口，也支持多端口
 * @returns 命中的对端记录数组（已带 sourceAddress 与 port）
 */
export async function scanForPeers({
  port,
  ports,
  addresses,
  timeoutMs = 800,
  concurrency = 64,
  onProgress,
  signal,
} = {}) {
  const found = [];
  const portList = (ports ?? (port === undefined ? [] : [port])).filter(
    (p) => Number.isInteger(p) && p >= 1 && p <= 65535,
  );
  if (portList.length === 0) return found;

  const targets = [];
  for (const p of portList) {
    for (const ip of addresses ?? candidateAddresses()) targets.push({ ip, port: p });
  }

  let index = 0;
  let done = 0;

  const worker = async () => {
    while (index < targets.length) {
      if (signal?.aborted) return;
      const { ip, port: p } = targets[index];
      index += 1;
      try {
        const res = await fetch(`http://${ip}:${p}/mesh/v1/health`, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: "application/json" },
        });
        if (res.ok) {
          const body = await res.json();
          // 必须是我们的协议、且不是自己
          if (body && body.app === "dsh-mesh" && body.id) {
            found.push({ ...body, sourceAddress: ip });
          }
        }
      } catch {
        /* 绝大多数地址不会有响应，这是正常的 */
      }
      done += 1;
      onProgress?.(done, targets.length, found.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, worker));
  return found;
}
