/**
 * 对端连接：在所有候选地址里挑一个真能连上的。
 *
 * 单独成模块的原因有两个：
 *   1. 它不依赖任何 DSH 包，可以脱离宿主单独跑集成测试
 *      （lib/_selftest-peerlink.mjs 用真 HTTP server 验证换路逻辑）
 *   2. index.js 里两处派发（agent 工具 mesh_run、页面 /mesh/api/send）
 *      需要完全一致的换路语义，抄两遍必然会漂
 *
 * 为什么不能只认对端自述的 host：它可能已经不通 —— 对端换了网、或新开了
 * Tailscale，而它自己不知道我们是从哪条路过来的。旧版只打 host，一旦对端
 * 广播的是我们到不了的地址（例如它在 192.168.x、我们只能走 100.64.x），
 * 就变成"两边都看得见对方、却永远连不上"。
 */
import { peerHosts } from "./discovery.js";
import { directFetch } from "./directfetch.js";

/**
 * 依次尝试对端的所有候选地址，返回第一个连上的。
 * 只用于**只读**请求，所以可以放心逐个试。
 * @returns {Promise<{host: string, res: Response}>}
 */
export async function fetchPeerAny(peer, path, { timeoutMs = 3000, init } = {}) {
  const hosts = peerHosts(peer);
  if (hosts.length === 0) throw new Error("对端没有可用地址");
  let lastErr;
  for (const host of hosts) {
    try {
      const res = await directFetch(`http://${host}:${peer.port}${path}`, {
        ...init,
        timeoutMs,
      });
      return { host, res };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("所有候选地址都连不上");
}

/** 只读探测对端健康接口；成功返回 { host, body }，全都不通返回 null。 */
export async function probePeerHealth(peer, timeoutMs = 3000) {
  if (!peer?.port) return null;
  try {
    const { host, res } = await fetchPeerAny(peer, "/mesh/v1/health", {
      timeoutMs,
      init: { headers: { accept: "application/json" } },
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (body?.app !== "dsh-mesh" || !body.id) return null;
    return { host, body };
  } catch {
    return null;
  }
}

/** 找出对端当前真正连得上的地址；都不通返回空串。 */
export async function resolvePeerHost(peer, timeoutMs = 3000) {
  return (await probePeerHealth(peer, timeoutMs))?.host ?? "";
}

/**
 * 把一条任务投递给对端，自动在所有候选地址里挑一个连得上的。
 *
 * 多候选地址时先做一次只读探测再 POST：POST 失败后重试有重复投递的风险
 * （对端可能已经收到并开跑，只是回包丢了），先用 /health 挑出真正通的地址
 * 更稳妥。只有一个候选地址时（绝大多数情况）不额外探测，行为与旧版一致。
 *
 * @param target 对端记录（需要 id / port / host / hosts / sourceAddress）
 * @param payload 任务正文
 * @param token 配对码（写进 X-Dsh-Mesh-Token）
 * @param discovery 可选；连上后会调 markReachable 让记录自愈
 * @returns {Promise<{res: Response, host: string, body: object}>}
 */
export async function deliverTask({ target, payload, token, timeoutMs = 20000, discovery } = {}) {
  const hosts = peerHosts(target);
  if (hosts.length === 0) throw new Error("对端没有可用地址");

  let order = hosts;
  if (hosts.length > 1) {
    const live = await resolvePeerHost(target, Math.min(3000, timeoutMs));
    if (live) order = [live, ...hosts.filter((h) => h !== live)];
  }

  let lastErr;
  for (const host of order) {
    try {
      const res = await directFetch(`http://${host}:${target.port}/mesh/v1/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Dsh-Mesh-Token": token ?? "" },
        body: JSON.stringify(payload),
        timeoutMs,
      });
      const body = await res.json().catch(() => ({}));
      // 记下这条真的通的路，下次直接用它
      try {
        discovery?.markReachable?.(target.id, host);
      } catch {
        /* 记录自愈失败不该影响派发结果 */
      }
      return { res, host, body };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("所有候选地址都连不上");
}
