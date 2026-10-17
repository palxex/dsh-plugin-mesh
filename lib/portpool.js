/**
 * 端口池：在池内依次尝试监听，全被占用才退回随机端口。
 *
 * 单独抽出来是为了**能测** —— "回退到什么端口"正是 2026-10 那次事故的根因：
 * 旧版一撞到 EADDRINUSE 就直接 `listen(0)` 退回随机端口，后果有两个：
 *   1. 对端扫描固定端口时永远扫不到本机，主动发现这条路彻底断掉；
 *   2. 每次重启端口都变，对端记录里的端口必然过期。
 * 换成池内下一个固定端口就都解决了：对端扫池子就能命中，端口也稳定。
 *
 * 这里同时认 EACCES：WSL 的 mirrored 网络模式下，端口被镜像层独占时，
 * Windows 侧拿到的是 EACCES 而不是 EADDRINUSE（实测）。
 */
import { normalizePortList } from "./discovery.js";

/**
 * 在端口池里依次尝试监听。
 *
 * @param server 已经 createServer() 好、但还没 listen 的 net.Server / http.Server
 * @param pool   候选端口（有序）；空则只试随机端口
 * @param onSkip 每次跳过某个端口时的回调 (port, code) => void，用于打日志
 * @returns {{port: number, inPool: boolean, pool: number[]}}
 */
export function listenOnPortPool(server, pool, { onSkip } = {}) {
  const ports = normalizePortList(pool, []);
  return new Promise((resolve, reject) => {
    let index = 0;

    const attempt = () => {
      const exhausted = index >= ports.length;
      const port = exhausted ? 0 : ports[index];
      server.once("error", (err) => {
        // 被占用就试池内下一个
        if (!exhausted && (err?.code === "EADDRINUSE" || err?.code === "EACCES")) {
          onSkip?.(port, err.code);
          index += 1;
          attempt();
          return;
        }
        reject(err);
      });
      server.listen(port, "0.0.0.0", () => {
        const addr = server.address();
        resolve({ port: addr.port, inPool: ports.includes(addr.port), pool: ports });
      });
    };

    attempt();
  });
}
