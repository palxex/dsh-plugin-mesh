/**
 * 框架 API 契约检查：插件调用的 DSH 服务方法必须真的存在。
 *
 *   node tools/service-api-check.mjs
 *
 * 为什么需要它：本插件重度依赖 6 个宿主服务，而 DSH 还在 rc 阶段、API 会改名。
 * 2026-10-07 就栽在这里 —— `wakeAgent()` 调了 `agentPresets.standingKeyFor()`，
 * 而 DSH 0.2.0-rc.2 里根本没有这个方法（官方 dsh-webhook 用的是 `acquireScope`）。
 * 后果是**每一次入站唤醒都抛 TypeError**，入站功能等于从来没工作过；
 * 对外只看到 status=dispatch-failed，原因不可见，只能 SSH 上去翻。
 *
 * 单元测试抓不到这种问题：它们不加载真实的 DSH 服务。所以这里做静态核对 ——
 * 从 lib/index.js 里抽出所有 `c.<service>.<method>(` 调用，逐个到对应包的源码里找。
 *
 * 两个不算违规的例外（自动识别，不需要写标记）：
 *   · 注释里的提及（先剥注释）
 *   · 能力探测守卫下的兼容分支：`typeof c.<svc>.<m> === "function"` 之后的调用
 *
 * 环境变量 DSH_MODULES 可指定 @deepseek-ai 包目录；找不到就跳过（不算失败）。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DSH_MODULES =
  process.env.DSH_MODULES || "/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

/** 服务名 → 提供它的 DSH 包。 */
const SERVICE_PACKAGE = {
  agents: "dsh-agent",
  agentPresets: "dsh-agent-preset-registry",
  permissionPresets: "dsh-permission-presets",
  sessionTitle: "dsh-session-title",
  workspaceRegistry: "dsh-workspace",
  agentDefaultModel: "dsh-agent-default-model",
};

if (!existsSync(DSH_MODULES)) {
  console.log(`⚠ 找不到 DSH 包目录（${DSH_MODULES}），跳过契约检查。`);
  process.exit(0);
}

const src = readFileSync(join(ROOT, "lib", "index.js"), "utf8");

/**
 * 去掉注释，但**保留字符串/模板字面量**（否则 "http://..." 会被当成行注释，
 * 把同一行后面的真代码一起吃掉），并且**保留换行数**（这样报出来的行号还是原文件的）。
 */
function stripComments(s) {
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "/" && s[i + 1] === "/") {
      while (i < n && s[i] !== "\n") i += 1;
    } else if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) {
        if (s[i] === "\n") out += "\n"; // 保住行号
        i += 1;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        if (s[i] === "\\") {
          out += s[i] + (s[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += s[i];
        if (s[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const clean = stripComments(src);
const services = Object.keys(SERVICE_PACKAGE).join("|");
const EXPR = `(?:c|scoped|ctx)\\.(?:${services})\\.[A-Za-z_$][\\w$]*`;

// 1) 先收集"能力探测守卫"里出现过的表达式：typeof c.agentPresets.standingKeyFor === "function"
const guarded = new Set();
for (const m of clean.matchAll(new RegExp(`typeof\\s+(${EXPR})`, "g"))) guarded.add(m[1]);

// 2) 只认**真正的调用**（名字后面紧跟 "("），且不在守卫集合里
const callRe = new RegExp(`\\b(${EXPR})\\s*\\(`, "g");
const calls = new Map(); // service → method → 首次出现的行号
const skipped = new Set();
for (const m of clean.matchAll(callRe)) {
  const expr = m[1];
  const [, service, method] = expr.split(".");
  if (guarded.has(expr)) {
    skipped.add(`${service}.${method}`);
    continue;
  }
  if (!calls.has(service)) calls.set(service, new Map());
  const per = calls.get(service);
  if (!per.has(method)) per.set(method, clean.slice(0, m.index).split("\n").length);
}

/** 把某个包的所有源码拼起来（懒加载）。 */
const sourceCache = new Map();
function packageSource(pkg) {
  if (sourceCache.has(pkg)) return sourceCache.get(pkg);
  const dir = join(DSH_MODULES, pkg);
  let text = "";
  if (existsSync(dir)) {
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          try {
            text += readFileSync(full, "utf8");
          } catch {
            /* 忽略读不了的文件 */
          }
        }
      }
    };
    walk(dir);
  }
  sourceCache.set(pkg, text);
  return text;
}

const problems = [];
let checked = 0;
for (const [service, methods] of calls) {
  const pkg = SERVICE_PACKAGE[service];
  const text = packageSource(pkg);
  if (text === "") {
    problems.push(`  ❌ 找不到提供 ${service} 的包 ${pkg}（DSH_MODULES=${DSH_MODULES}）`);
    continue;
  }
  for (const [method, line] of methods) {
    checked += 1;
    // 只要整个包里出现过这个名字就算存在（保守：宁可漏报，不要误报）
    if (!text.includes(method)) {
      problems.push(`  ❌ lib/index.js:${line} 调用了 ${service}.${method}()，但 ${pkg} 里没有这个方法`);
    }
  }
}

console.log(`DSH 包目录: ${DSH_MODULES}`);
console.log(`检查了 ${calls.size} 个服务、${checked} 个方法调用`);
if (skipped.size > 0) {
  console.log(`跳过 ${skipped.size} 处能力探测守卫下的兼容调用: ${[...skipped].join(", ")}`);
}
console.log("");
for (const p of problems) console.log(p);
if (problems.length > 0) {
  console.log(`\n共 ${problems.length} 处不匹配 —— 多半是 DSH 版本升级后 API 改名了。`);
  process.exit(1);
}
console.log("  ✅ 插件调用的服务方法在当前 DSH 版本里都存在");
