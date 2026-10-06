/**
 * 直连 HTTP —— 永不经过环境变量里的代理。
 *
 * 为什么不能用全局 fetch：
 *   Node 在 `NODE_USE_ENV_PROXY=1` 时会按 `http_proxy` / `https_proxy` 代理
 *   **所有** fetch 请求，只有 `no_proxy` 里命中的地址例外。而 undici 的
 *   `no_proxy` 只支持**精确主机名**和 `*`（实测）：
 *
 *       127.0.0.1      ✅ 精确命中
 *       *              ✅ 全部绕过
 *       127.0.0.*      ❌ 通配无效
 *       127.0.0.0/8    ❌ CIDR 无效
 *
 *   所以 `no_proxy=...,10.*,172.16.*,192.168.*` 这种常见写法对 Node **完全无效**
 *   （对 curl 才有效），更不可能覆盖 `100.64.0.0/10`（RFC 6598 CGNAT，
 *   Tailscale / headscale 分配的就是它）。
 *
 *   后果：本插件发往 tailnet 对端的扫描/派发请求全被丢给代理，代理到不了 tailnet
 *   → 超时。现象是**单向故障**："对端能发现我、我永远发现不了对端"，
 *   因为对端机器上没有这套代理配置。
 *
 * 为什么直连是对的：
 *   本插件只会访问局域网 / tailnet 里的 mesh 对端（固定端口 45917 的明文 HTTP），
 *   没有任何理由走代理 —— 代理反而会把它挡在外面。所以这里用 node:http 自己发，
 *   它从不读取代理环境变量。
 *
 * 与 fetch 的差异：只支持 http:（插件本来只用 http），响应体一次性读进内存
 * （mesh 的响应都很小）。
 */
import http from "node:http";

/** 一个最小的、接口与 fetch Response 兼容的响应对象。 */
class DirectResponse {
  #text;
  constructor(status, headers, text) {
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.headers = headers;
    this.#text = text;
  }
  async text() {
    return this.#text;
  }
  async json() {
    return JSON.parse(this.#text);
  }
}

function timeoutError(timeoutMs) {
  const err = new Error(`连接超时（${timeoutMs}ms）`);
  // 保持与 `fetch` + `AbortSignal.timeout()` 一致的错误名，调用方按名字判断超时
  err.name = "TimeoutError";
  err.code = "ETIMEDOUT";
  return err;
}

function abortError() {
  const err = new Error("请求已取消");
  err.name = "AbortError";
  return err;
}

/**
 * 发一个直连 HTTP 请求（不经过任何代理）。
 *
 * @param url 形如 http://1.2.3.4:5678/path
 * @param options.method  默认 GET
 * @param options.headers 请求头
 * @param options.body    字符串正文（调用方自己 JSON.stringify）
 * @param options.timeoutMs 超时；超时抛 name="TimeoutError" 的错误
 * @param options.signal 可选的取消信号
 * @returns {Promise<DirectResponse>} 带 status / ok / headers / text() / json()
 */
export function directFetch(url, options = {}) {
  const { method = "GET", headers = {}, body, timeoutMs = 20000, signal } = options;

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`不是合法的 URL: ${url}`));
      return;
    }
    if (parsed.protocol !== "http:") {
      reject(new Error(`directFetch 只支持 http:（收到 ${parsed.protocol}）`));
      return;
    }

    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      fn(value);
    };

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "Content-Length": Buffer.byteLength(body) }),
        },
        // 关键：显式关闭 agent 复用。既不共享 socket（扫描会打几百个连不上的
        // 地址，留 keep-alive 只是浪费 fd），也表明我们**有意**直连、绕开代理。
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          finish(resolve, new DirectResponse(res.statusCode, res.headers, Buffer.concat(chunks).toString("utf8")));
        });
        res.on("error", (err) => finish(reject, err));
      },
    );

    function onAbort() {
      req.destroy(abortError());
    }

    // 用独立定时器，**不要**用 req.setTimeout()：后者要等 socket 连上之后才生效
    // （Node 文档："once a socket is assigned to this request and is connected"），
    // 而扫描打的大多是连不上的地址 —— 连接阶段没有超时，整个扫描会一直挂住。
    // 语义上这也和 fetch 的 AbortSignal.timeout 一致：总时限，不是空闲时限。
    timer = setTimeout(() => req.destroy(timeoutError(timeoutMs)), timeoutMs);
    req.on("error", (err) => finish(reject, err));

    if (signal) {
      if (signal.aborted) {
        req.destroy(abortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * 当前环境有没有会让全局 fetch 走代理的配置。
 *
 * 只用于启动时打一行提示 —— 本插件的通信一律直连，不受这些变量影响，
 * 但用户看到日志才知道"为什么我设了代理它还能连上对端"。
 */
export function proxyEnvSummary() {
  const vars = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"].filter(
    (k) => process.env[k],
  );
  const flag = String(process.env.NODE_USE_ENV_PROXY ?? "").toLowerCase();
  return { nodeUseEnvProxy: flag === "1" || flag === "true", vars };
}
