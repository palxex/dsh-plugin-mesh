# dsh-plugin-mesh

DSH 的局域网 Mesh 插件：**启动后自动发现同一网段的其他 DSH 实例**，在侧栏提供一个
操作页面显示各机器的在线状态，并支持把任务派给对端的 agent 执行。

用起来就是你要的那个效果：在 A 机器上开发，把「部署到 B」这件事丢给 agent，
你只下大命令。

**零配置**：固定端口 + 自动扫描 + ping，装上就能发现彼此，**不需要配对码**。
首次打开 Mesh 页面会让你给这台机器起个名字（默认填主机名），别的机器就靠这个名字找你。

```
┌──────── A 机器 (DSH) ────────┐          ┌──────── B 机器 (DSH) ────────┐
│  mesh 插件  :45917            │          │  mesh 插件  :45917            │
│   ├ UDP 组播心跳  ◀───────────┼──────────┼──▶  被动发现                  │
│   ├ 主动扫本网段  ────────────┼──────────┼──▶  兜底发现                  │
│   ├ ping 保活     ────────────┼──────────┼──▶  在线状态                  │
│   └ 侧栏 Mesh 页面            │          │                              │
│                               │───任务──▶│  唤醒本机 agent 执行          │
│                               │◀──回派───┤                              │
└───────────────────────────────┘          └──────────────────────────────┘
```

---

## 发现机制：两条互补的路

只靠组播是不够的 —— **很多路由器/AP 会隔离客户端组播，Windows 防火墙默认也拦入站组播**。
所以这里同时用两条路，任一条通就能发现：

| 路径 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **组播心跳** | 每 5s 向 `239.255.42.99` 的端口池（`45892/41443/48119/51307/54757`）各广播一次，自己只绑池内第一个空闲端口 | 零配置、即时、不产生额外连接 | 可能被路由器/防火墙挡掉 |
| **主动扫描** | 并发 GET 本网段每台机器**端口池里每个端口**的 `/mesh/v1/health` | 只要 TCP 通就能成，最可靠 | 扫一次约 1~2 秒；254 个地址 × 端口数 |

再加一条**ping 保活**：每 10s GET 已知对端的 `/mesh/v1/health`，刷新在线状态。
这条让"发现"一旦建立就不再依赖组播 —— 即使组播完全不通，扫描见过一次之后也能一直维持。

扫描时机：**启动时**（带退避重试，因为常抢在对方启动之前）+ **每 60s** 一次 + UI 上手动触发。

### 端口池：为什么不是单个固定端口

**默认端口 45917**，固定端口是"扫一下就能连上"的前提。但一台机器上完全可能同时跑两个
实例 —— 最典型的是 **Windows 桌面端 + WSL 里的 `dsh web`**，而 WSL 一旦开了
`networkingMode=mirrored`，两边就**共用同一套网卡、IP 和端口空间**：

- 谁先绑上 `45917` / `45892`，谁就独占；
- 后到的那个拿到 `EADDRINUSE`，UDP 侧在 Windows 上即使 `reuseAddr=true` 也只会拿到
  `EACCES`（镜像层用的是独占绑定）；
- 结果是后到者组播 socket 从未建立：**发不出心跳，也收不到任何心跳**。

旧版在这种情况下直接 `listen(0)` 退回随机端口，于是它既扫不到别人、也扫不到自己 ——
两个致命后果叠在一起，就是"WSL 里一切正常，外面这台一台都发现不了"。

所以现在两条路都用**端口池**：

| | 行为 |
|---|---|
| `port` + `fallbackPorts` | 依次尝试 `45917 → 41521 → 42839 → 48271 → 51349 → 54709 → 58237 → 61553`，全被占才退回随机端口 |
| `multicastPorts` | 只绑池内**第一个**能绑上的端口，但心跳**发往池内全部端口** |

组播为什么"只绑一个、发全部"：如果每个实例都把池内所有端口绑上，第一个实例就把池子
占满了，第二个照样没得用 —— 那等于没解决任何问题。而"发往全部端口"保证了 A 绑
`45892`、B 绑 `41443` 时，A 的心跳 B 在 `41443` 能收到，B 的心跳 A 在 `45892` 能收到。

⚠️ **升级要两边都升**：新版会往池内五个端口发心跳，但老版（0.2.0）只往 `45892` 发。
只升一侧时，绑在 `41443` 的那个收不到老版对端的心跳 —— 不过主动扫描（会扫整个端口池）
仍然能发现它。

### 组播的作用范围：比"局域网"更窄

`239.255.42.99:45892` 是我在私有组播段里挑的（`239.0.0.0/8` 是 RFC 2365 定义的
管理范围，相当于组播里的"私有地址"），**TTL 设为 1**，所以：

- ✅ 同一网段（同一个二层广播域）内有效
- ❌ **路由器不转发** —— 跨子网/VLAN 到不了，那种情况要配 `scanRanges`
- ❌ **AP isolation 会连它一起挡**（那是把客户端之间的所有流量都隔离，不只是组播）
- ❌ **Tailscale / WireGuard 这类覆盖网完全不承载组播**，只能靠扫描
- ⚠️ 部分交换机的 IGMP snooping 在没有 querier 时会丢掉组播
- ⚠️ Windows 防火墙默认拦入站组播，要放行 UDP 45892、41443、48119、51307、54757

正因为组播有这么多坑，才加了扫描那条路：**只要 TCP 通，扫描就能发现**。

### 地址模型：一次广播、多条路

一台机器常常同时挂在多张网上（物理内网 `192.168.x`、Tailscale 的 `100.64.x`、
Docker 的 `172.17.x`…），而"对端从哪条路连得上"**本机无从判断**。所以：

- 心跳里带上**全部**候选地址（`hosts` 数组），按"最可能连得上"排序
- 对端按 `实测来源地址 → 自述 hosts → 自述 host` 的顺序逐个尝试，
  连上后把那条路记下来（对端记录自愈）
- 多候选时先做一次只读 `/health` 探测再 POST，避免把重试变成重复投递

地址排序规则（`preferredAddress()`）：

| 优先级 | 判据 |
|---|---|
| 1 | 非虚拟网桥（`docker0` / `veth` / `vmnet` 等垫底） |
| 2 | 地址类别：RFC1918 > **CGNAT `100.64.0.0/10`** > 公网 > 链路本地 |
| 3 | 网卡名：`en0`/`eth0`/`wlan0` > `en*`/`eth*` > 隧道（`tailscale*`/`wg*`/`utun*`） |

> `100.64.0.0/10` 是 RFC 6598 的 CGNAT 段，Tailscale / headscale 分配的就是它。
> 它被当作**私网地址**参与排序，不会因为网卡名不叫 `eth*` 就被漏掉。

万一自动挑错了首选，可以在 Mesh 页面的「对外地址」里手动钉住，
或写配置 `announceAddress: "100.64.7.5"`。钉住只影响首选顺序，其余地址照常广播。

---

## 身份与命名

每台机器有**两个**标识，分工不同：

| 标识 | 是什么 | 稳定性 | 用途 |
|---|---|---|---|
| **instanceId** | 启动时随机生成的 8 字节 hex | 每次启动都变 | 内部用：去重、识别"这条是我自己发的" |
| **machineName** | 人可读的名字，如 `客厅的Mac` | 持久保存 | 你和 agent 用它指代这台机器 |

**名字解析优先级**：插件配置 `machineName` > 用户首次启动时填的 > 系统主机名。

首次启动时（还没命名过、落在主机名上）Mesh 页面会主动问你一次：输入框预填主机名，
点「就这个」直接用，或改成你想要的名字。名字存在 `$DSH_HOME/mesh/state.json`
（和配对码同一个文件，权限 0600），**改完立刻重新广播**，对端不用重启就能看到。

### 重名怎么办

名字是人手填的，可能撞。页面会检测并告警，派发时也不会随便挑一台：

- **从 A 看**：`--peer winbox` 只要在 A 的上游对端里唯一就能用（自己不算）
- **从第三台机器看**：如果它发现有两台都叫 winbox，`mesh_run` 会**拒绝**并列出候选，
  让你改用 `<ip>:<port>` 精确定位

地址也接受实例 id 或 `ip:port`，所以撞名时总有办法精确指定。

---

## 实测验证状态

以下都在**真实 DSH host** 上跑出来（临时 DSH_HOME，未动你正在用的应用）：

| 项目 | 结果 |
|---|---|
| 配置装配进 profile | ✅ `--dump-config` 含本项目两行 |
| 插件加载、`apply` 执行 | ✅ 挂载 5 个 UI 接口、注册 4 个工具 |
| **两个真实 DSH 互相发现（仅扫描，组播全关）** | ✅ 双向，24 秒内（含启动竞态重试） |
| 两个真实 DSH 互相发现（组播开） | ✅ 双向，1 秒内 |
| **零配对派发任务** | ✅ `ok: true`，全程没有任何配对操作 |
| **对端 agent 被唤醒** | ✅ 建了 `mesh-*` 会话，17 个事件，含任务提示词 + 线程 + 回派指令，`turn/start` → `assistant/attempt` |
| **离线判定** | ✅ 杀掉对端后约 20 秒标记离线（ttl 20s） |
| 固定端口被占用 → 回退 | ✅ 配置 45919、实际 63570（旧版行为，现已改为池内下一个固定端口） |
| **端口池：主端口被占 → 绑池内下一个** | ✅ Linux + Windows 双平台，`_selftest-portpool.mjs` |
| **端口池：心跳发往池内全部端口** | ✅ 绑 `x+1` 时在 `x+2` 上能收到心跳 |
| **端口池：两实例各绑一个仍互相可见** | ✅ 双向发现，不再是"有你没我" |
| **端口池：TCP 池内全占 → 随机兜底** | ✅ 返回 `inPool:false`，日志明确标注 |
| `requirePairing: true` 时 | ✅ 错误 token → 403；正确 token → 200 |
| **首次启动询问名字** | ✅ 未命名时 `needsName=true`，输入框预填主机名 |
| **改名立刻传播** | ✅ 改完 **2 秒内**对端就看到新名字（立即重新广播） |
| **名字持久化** | ✅ 存 `state.json`，重启后仍是 `客厅的Mac` / `source=saved` |
| 名字校验 | ✅ 空、含 `/`、超 32 字符均被拒 |
| 配置优先 | ✅ 配置里写了 `machineName` 时改名返回 409，不静默覆盖 |
| 重名检测 | ✅ 两端 `duplicateNames` 均正确列出 |
| 客户端 bundle 被提供 | ✅ 出现在 `__DSH_BOOT__`，路由 200，内容与源码逐字节一致 |
| UI 页面渲染 | ✅ 机器列表 / 任务记录两个 tab |
| 不花你的 token | ✅ 测试环境无模型密钥，agent 止步于 `no API key` |

**没验证的**（如实说明）：
- 没在你**正在运行的** DSH Desktop 里验证 —— 需要重启应用，会掐断本次会话。
  用 `dev-boot.mjs` 复现了真实主进程的模块解析行为来代替。
- Windows 侧只在 Electron-as-node 环境里跑过自测（端口池、组播回环、TCP 回退都过了），
  没在完整的 DSH Desktop + WSL mirrored 组合上跑端到端。防火墙要放行 TCP 45917、41521、42839、48271、51349、54709、58237、61553
  和 UDP 45892、41443、48119、51307、54757。
- `scanPorts` 仍然保留，但它现在只用于**追加池外**的端口 —— `port` 和 `fallbackPorts`
  是始终会扫的。

---

## 安装

两台机器都装。**装完必须重启 DSH Desktop 才会加载。**

### 方式 A：一键脚本（推荐）

```bash
git clone https://github.com/peng456/dsh-plugin-mesh.git
cd dsh-plugin-mesh
./install.sh
```

脚本做两件事，且**可重复执行**（已装就跳过）：

1. 把插件**复制**到 `~/.dsh/profiles/desktop/node_modules/dsh-plugin-mesh/`
2. 把它加进该 profile `package.json` 的 `dsh.profile.bundles`
   （改前自动备份为 `package.json.bak`）

常用选项：

```bash
./install.sh --dry-run              # 只打印会做什么，不落盘
./install.sh --profile web          # 装到别的 profile
./install.sh --home /path/to/.dsh   # 指定 DSH_HOME
./install.sh --uninstall            # 卸载（删目录 + 从 bundles 移除）
```

### 方式 B：手动装

```bash
# macOS
cp -R dsh-plugin-mesh ~/.dsh/profiles/desktop/node_modules/dsh-plugin-mesh

# Windows (PowerShell)
Copy-Item -Recurse dsh-plugin-mesh "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-mesh"
```

然后在 `~/.dsh/profiles/desktop/package.json` 的 `bundles` 里加上 `"dsh-plugin-mesh"`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-plugin-mesh"],
      "patchReload": "live"
    }
  }
}
```

> ⚠️ **必须是真实目录，不能是软链。** DSH 的 profile 包解析器会拒绝 realpath 落在
> `<profile>/node_modules` 之外的包（`module-resolution-*.js` 里那条判断，
> 目的是防止陈旧的外部状态覆盖已封装安装）。把插件软链到你的工作目录会在启动时
> 报 `ERR_MODULE_NOT_FOUND`。`install.sh` 已经处理好了这一点。

### 方式 C：官方命令（用 DSH Desktop 自带的终端）

托盘/菜单 → 终端：

```bash
dsh plugin add /path/to/dsh-plugin-mesh
```

注意 `dsh plugin --profile desktop` 在**普通终端**里会被拒绝
（`bin.js:29`：profile "desktop" is managed exclusively by the Electron application），
必须用应用自带的那个终端。

### Windows 防火墙

```powershell
New-NetFirewallRule -DisplayName "DSH Mesh" -Direction Inbound -Protocol TCP -LocalPort 45917,41521,42839,48271,51349,54709,58237,61553 -Action Allow
New-NetFirewallRule -DisplayName "DSH Mesh (multicast)" -Direction Inbound -Protocol UDP -LocalPort 45892,41443,48119,51307,54757 -Action Allow
```

只放行 TCP 也行 —— 那时靠主动扫描发现，不依赖组播。

## 使用

侧栏会出现一个 **Mesh** 图标（三个节点连成的网状），点开是主页面：

- **本机信息**：机器名、地址、端口、当前发现方式与配对要求
- **发现的机器**：每台一行，在线绿点/离线灰点，显示地址、系统、用户、最后心跳；
  每行「探测」和「派发任务」
- **扫描本网段** / **重新广播** 按钮
- **派发任务**：选目标机器 → 填任务 → 派发
- **任务记录**：收到 / 派出的任务
- **配对码**（折叠，默认不需要）

agent 多出四个工具：

| 工具 | 作用 |
|---|---|
| `mesh_peers` | 列出发现的机器 |
| `mesh_scan` | 主动扫本网段，找还没发现的机器 |
| `mesh_run` | 把任务派给某台机器的 agent（异步） |
| `mesh_tasks` | 查看收到/派出的任务记录 |

所以你可以直接说：

> 「看看局域网里有哪些机器，然后让 B 把 web 服务重新部署一下，跑完告诉我。」

---

## 工作原理

### 唤醒：自包含实现，不依赖额外插件

agent 没有事件循环，只在有回合时才思考。所以收到对端任务后，必须**建一个会话并让它跑起来**。

DSH 提供了官方插件 `@deepseek-ai/dsh-webhook` 做这件事，但**本插件没有用它**，理由：

1. 它不在任何默认 bundle 里，靠补丁替用户插一行，会让"装一个插件"变成配置里两行，困惑
2. 更实际的问题：万一它已经被启用（比如你以后装了 GitHub webhook 插件），
   cordis 的 `provide` 遇到重名会直接抛错（`service "webhookRuntime" has been registered at <...>`），
   而且那是在它的构造函数里，**本插件的安全网拦不住**

所以这里按官方 `createWebhookSession` 的做法自己走一遍，用到的都是 DSH 基础服务
（桌面 profile 本来就全都有）：

```
ctx.permissionPresets.resolve / set      校验并设置权限 preset
ctx.agentPresets.resolve / mount         解析并挂载 agent preset
ctx.workspaceRegistry.create             建/取工作区
ctx.agents.create                        建 Agent
ctx.sessionTitle.rename                  给会话起名
ctx.agentDefaultModel.currentSelection   取默认 provider/model
agent.followup(createUserMessage(...))   ← 这一步才是"唤醒"
```

服务齐备时才启用（用 `ctx.inject([...])` 探测）；缺任何一个就降级为"只收件不唤醒"，
并在日志里说明缺了什么。**插件是自包含的，profile 里只多一行。**

### 为什么发现要两条路

我先只做了组播，后来加扫描，是因为组播在真实家庭网络里失败率比想象中高：
AP isolation、Windows 防火墙默认策略、跨 VLAN，任何一个都能让它静默失效。
而"TCP 直连固定端口"只要网络通就能成。

---

## 配置项

默认已经可用。要改就在 profile 的 `cordis.patch.yml` 里按 id 覆盖
（注意：patch 是**整体替换** config，所以要把想保留的项一起写上）：

```yaml
- id: mesh
  config:
    machineName: ''            # 对端列表里的名字，留空用主机名
    port: 45917                # 固定端口
    fallbackPorts: [41521, 42839, 48271, 51349, 54709, 58237, 61553]  # 分散取值，避免被整段预留一锅端
    useMulticast: true         # 组播被动发现
    multicastPorts: [45892, 41443, 48119, 51307, 54757]  # 只绑第一个空闲的，但心跳发往全部
    scanOnStart: true          # 启动扫描（带退避重试）
    scanIntervalMs: 60000      # 周期扫描；0 = 关闭
    scanRanges: []             # 额外网段（/8~/32），如 ["100.64.0.0/24"]；本机 /24 始终会扫
    scanMaxAddresses: 1024     # 单次扫描地址预算；超出的网段只扫前 N 个并告警
    scanPorts: []              # 除 port + fallbackPorts 外额外要扫的端口
    scanConcurrency: 128       # 并发探测数（多端口扫描，默认比旧版翻倍）
    scanTimeoutMs: 800
    pingIntervalMs: 10000      # ping 保活；0 = 关闭
    announceAddress: ''        # 手动钉住广播首选地址，如 "100.64.7.5"；留空自动挑
    announceIntervalMs: 5000
    peerTtlMs: 20000           # 多久没消息算离线
    requirePairing: false      # 见下
    agentPreset: standard
    permissionPreset: workspace-write
    workspaceRoot: ''
    # ── 循环限速 ──
    maxWakesPerThread: 30      # 每窗口内最多自动唤醒几次；0 = 不限制
    threadWindowMs: 3600000    # 窗口长度（毫秒），默认 1 小时
    threadCooldownMs: 20000    # 两次自动唤醒的最小间隔；0 = 不限制
    minTaskChars: 24           # 正文短于此长度只入箱不唤醒（挡 ping/ack）
```

### 循环限速（重要）

**为什么需要**：入站任务会自动新建会话并立刻让 agent 开跑，而每条消息都由
远端决定。两个 agent 互相回执时会形成自持的 ping-pong —— 实测一个互回执线程
在 2.5 小时内自动开了 54 个会话、约 800 万 token，全部是重复探索。

四道闸门，任何一道触发都**只入箱、不唤醒**（任务仍可在 `/mesh/v1/tasks` 和
Mesh 页面看到，不会被丢弃）：

| 闸门 | 默认 | 作用 |
|---|---|---|
| `minTaskChars` | 24 | 太短的内容不开会话 |
| 寒暄识别 | 内置 | `ping` / `ack` / `收到` / `好的` 等整条即寒暄的，不开会话 |
| `threadCooldownMs` | 20s | 同一 thread 不会连续秒回，管**突发** |
| `maxWakesPerThread` | 30 | 同一 thread 在 `threadWindowMs` 内的唤醒上限，管**持续速率** |

`maxWakesPerThread` 是**滑动窗口限速，不是终身配额**：只统计最近
`threadWindowMs`（默认 1 小时）内的唤醒。窗口内的唤醒点会随时间自然过期，
该 thread 自动恢复，不需要重启。

⚠ **限速只会让循环变慢，不会让它停。** 如果循环的自然节奏低于上限，
窗口永远填不满，限速就永不触发 —— 实测事故节奏约 21 轮/小时，即使把上限
压到 10/小时，24 小时也仍会放行 276 轮。要真正止住请把上限设得**低于**
循环节奏，或配合会话复用把单价降下来。

#### 撞上限时交给用户决定

限速触发时**不静默丢弃**，而是在 Mesh 页面出现一张提示卡：

```
⚠ 有 thread 撞到唤醒上限，已暂停自动唤醒
  diet-reconcile   上限 30 次 / 60 分钟 · 已挡下 12 条
  [提高上限并放行最新一条]  [忽略]
```

- **提高上限** → 把该 thread 的上限翻倍（至少 +10），并**立刻放行最新那一条**
  （对话的最新一环）。其余被挡的仍留在收件箱 —— 一次性全放会造成新突发，
  反而失去限速的意义。覆盖值落盘，重启后仍有效。
- **忽略** → 只清提示，上限不变，任务仍留在收件箱。

对应的 API：`POST /mesh/api/throttle/raise {thread, cap?}`、
`POST /mesh/api/throttle/dismiss {thread}`；被挡的 thread 列表在
`GET /mesh/api/state` 的 `throttled` 字段里。

账本与覆盖值落盘在 `~/.dsh/mesh/threads.json`，**重启不清零** —— 否则对端
只要等到你重启就能重新灌满窗口。

另外两点配套改动：

- **同 thread 复用会话**：同一 `thread` 的后续消息注入同一个会话，不再每条
  从零重新探索。这是省 token 的最大一项，也让 agent 记得前几轮结论。
- **`noWake: true`**：发送方可以显式声明"这条只回执，别开跑"。`mesh_run`
  工具已带这个参数 —— 纯回执/确认请用它，否则会凭空开一个 agent 会话。

**已知绕过**：限速只认 `thread` 名字，而名字由发送方自由填写。对端若每次都
换 thread 名或不带 thread，就不受限速约束（此时只有 `threadCooldownMs` 的
突发冷却在起作用）。它是刹车，不是安全边界。

---

## 安全

**默认不需要配对** —— 同一内网里任何发现到本机的 DSH 都能派发任务。
对本机 agent 而言，这些任务会被当成一条用户消息（默认权限 `workspace-write`：
能读写工作区、能执行命令）。

这在**自己家的可信内网**里是合理取舍，也正是你要的"零配置"。但如果你在
**不完全可信的网络**里（合租、公司、宿舍、有访客设备、IoT 设备多），请打开：

```yaml
- id: mesh
  config:
    requirePairing: true
```

然后在两台机器的 Mesh 页面里互相对一下配对码（首次启动自动生成，页面上可直接复制）。
打开后所有控制接口都要过配对码，用 `timingSafeEqual` 比较。

其他：
- **发现是公开的**：同一网段任何人都能看见机器名、地址、系统、用户名。这是有意的取舍。
- **明文 HTTP**：局域网内可接受；跨不可信网络请套 SSH 隧道或 TLS 反代。

---

## 已知限制

1. **同 thread 复用会话，但跨 thread 不复用**：同一 `thread` 的后续消息会注入
   同一个会话；没带 `thread` 的任务仍然每次新建。（早于 2026-09 的版本无此复用，
   每条消息都新建会话。）
2. **去重只在进程生命周期内**（内存），重启后同 id 会重复入箱。
3. **没有离线排队**：对端离线时 `mesh_run` 直接失败，不暂存重投。
   （要这个能力可以用工作区里的 `lanmsg.py`。）
4. **同机多实例**：端口池能容纳的实例数是有限的（默认 TCP 3 个、组播 3 个）。
   超过之后新实例只能退回随机端口，主动扫描扫不到它。真要跑更多，把
   `fallbackPorts` / `multicastPorts` 加长即可 —— 代价是心跳和扫描的端口数同步增加。
5. **`sidebar.panellist` 槽位官方插件没人用过**（翻遍 58 个客户端 bundle，只有官方侧栏
   自己声明它）。我按源码契约接的，实测注册和渲染都正常，但不如 `sidebar.footer.action`
   那样有第三方先例。
6. **覆盖网（Tailscale 等）不能靠组播**：组播不跨 tailnet，必须把网段加进 `scanRanges`，
   而且 `100.64.0.0/10` 有 400 万个地址、扫不完。**推荐配成若干个 /24**，
   例如对端在 `100.64.0.0/24` 里就写 `scanRanges: ["100.64.0.0/24"]`；
   写 `/10` 只会扫前 `scanMaxAddresses` 个并告警。

---

## 跨网段 / Tailscale 怎么用

组播不跨 tailnet，所以两端要靠扫描。典型配置：

```yaml
- id: mesh
  config:
    scanRanges: ['100.64.0.0/24']   # 对端所在的 tailnet 网段（建议 /24，别写 /10）
    scanOnStart: true
    pingIntervalMs: 10000
```

启动日志里会看到：

```
mesh: 检测到 CGNAT/Tailscale 地址 100.64.7.2（网卡 tailscale0），已按私网地址处理
mesh: 本机候选地址（心跳里都会带上）: 192.168.1.10, 100.64.7.2
```

两端都看得见对方却连不上时，在页面上点「探测」——它会**逐个地址**列出结果：

```
✓ 可达且已配对（走 100.64.7.9）
✓ 100.64.7.9 (HTTP 200)   ✗ 192.168.1.99 connect ECONNREFUSED
```

---

## 与 HTTP 代理共存（踩过的坑）

**症状**：DSH 全局挂了代理时，出现**单向发现**——"对端能发现我，我永远发现不了对端"。

**原因**：`NODE_USE_ENV_PROXY=1` 会让 Node 的 `fetch` 按 `http_proxy` 代理**所有**请求，
只有 `no_proxy` 命中的例外。而 undici 的 `no_proxy` 匹配规则很窄（实测）：

| 写法 | 是否生效 |
|---|---|
| `127.0.0.1` | ✅ 精确命中 |
| `*` | ✅ 全部绕过 |
| `127.0.0.*` | ❌ 通配无效 |
| `127.0.0.0/8` | ❌ CIDR 无效 |

所以 `no_proxy=...,10.*,172.16.*,192.168.*` 这类常见写法**对 Node 完全无效**
（对 curl 才有效）——它们一直"看起来能用"，是因为代理通常就跑在本机，
转发到本机局域网地址当然也能成功。而 `100.64.0.0/10`（Tailscale）根本没法用
通配或 CIDR 表达，逐条列 IP 又不现实。

**本插件的做法**：所有对端通信走 `lib/directfetch.js`——基于 `node:http` 自己实现，
**从不读取代理环境变量**。因为插件只会访问局域网 / tailnet 里的 mesh 对端
（固定端口 45917 的明文 HTTP），没有任何理由走代理。

启动日志里会说明一句：

```
mesh: 检测到代理配置（http_proxy, https_proxy, NODE_USE_ENV_PROXY）；本插件与对端的通信一律直连，不经过代理
```

> 注意：这只影响**本插件**。其他插件的出站请求仍按你的代理配置走。
> 回归测试见 `lib/_selftest-proxy.mjs`——它在子进程里设好代理环境，
> 先断言全局 `fetch` **确实**被打挂（证明测试不是空的），再断言插件各条路径仍然直连成功。

---

## 开发与测试

```bash
# 搭隔离环境（把插件真实复制进 profile，不碰你的 desktop profile）
MACHINE=macbox PORT=45917 MULTICAST=false SCAN_PORTS="[41521]" \
  ./dev-setup.sh meshtest /tmp/mesh-dsh

# 启动（dev-boot.mjs 复现真实主进程的模块解析行为）
DSH_HOME=/tmp/mesh-dsh ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DSH Desktop 2.app/Contents/MacOS/DSH Desktop" \
  dev-boot.mjs --profile meshtest --port 8877
```

`dev-setup.sh` 支持的环境变量：`MACHINE` `PORT` `MULTICAST` `SCAN_ON_START`
`SCAN_PORTS` `PING_INTERVAL_MS` `REQUIRE_PAIRING`。

**为什么需要 `dev-boot.mjs`**：`desktop-cli.js:78` 只在 `app.asar` 内才安装 profile
包解析器，而这个安装是未打包的 `Resources/app`。真实 Electron 主进程
（`main.js:4478`）是**无条件**安装的，所以真实应用没这个问题，只有 CLI 路径有。

发现模块可以脱离 DSH 单独测：

```bash
npm test                                            # 全部回归测试（不需要网络/DSH）
node lib/_selftest-address.mjs                      # 地址分类、选地址、扫描计划
node lib/_selftest-portpool.mjs                     # 端口池：组播回退 + 发全部端口 + TCP 回退
node lib/_selftest-peerlink.mjs                     # 换路逻辑（真 HTTP server）
node lib/_selftest-e2e.mjs                          # 扫描 → 登记 → 派发 全链路
node lib/_selftest-proxy.mjs                        # 全局挂代理时仍能直连对端
node lib/_selftest-discovery.mjs alpha 45900 9000   # 两个进程同时跑可验证组播互相发现
npm run smoke                                       # 主机侧：host-smoke + startup-check
node tools/host-smoke.mjs                           # 沙箱里真跑 apply()，验证路由/配置/地址
node tools/startup-check.mjs                        # 集成：真跑 apply() + 启动扫描，专盯异步崩溃
node tools/startup-check.mjs --real                 # 同上但用真实网卡，会真连 tailnet
```

> `_selftest-discovery.mjs` 依赖真实的组播回环。在 WSL2 / 部分容器里组播不通
> （原版代码同样发现 0 个对端），此时用 `npm test` 里的 TCP 路径验证。

`npm run smoke` 是**改完插件不用重启 DSH 也能验证**的那条路：它把插件复制进一个
临时 `node_modules`（符号链接 DSH 自带的 `@deepseek-ai/*` 包），配上假的 ctx，
真实调用 `apply()` —— 起对端 HTTP 服务、挂 UI 路由、注册 agent 工具，再打真实的
`/mesh/api/*` 请求。全程不碰 `~/.dsh`（`DSH_HOME` 指向临时目录），也不开组播。

> **为什么还需要 `startup-check.mjs`**：`lib/_selftest-*.mjs` 都是**直接调用**模块函数，
> 绕过了 `index.js` 的接线。2026-10-06 就栽在这里——`index.js` 把一个只有 `{aborted}`
> 的裸取消令牌当 `AbortSignal` 传进了 `directFetch`，socket 出错时在事件回调里抛
> `TypeError`，逃逸成**未捕获异常**，直接把 `dsh web` 打挂；而当时 4 个单测文件全绿。
> 所以这个脚本做的是集成验证：真实 `apply()`、真实打开启动扫描、真实等待异步回调，
> 任何 `uncaughtException` / `unhandledRejection` 都算失败。
> 它在**修复前必须先失败**——否则这个检查就是空的。

---

## 文件结构

```
dsh-plugin-mesh/
├── package.json           # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml       # 只插入本插件（含默认配置）
├── lib/
│   ├── index.js           # 主机侧：发现编排 + 对端 HTTP + agent 工具 + UI 接口 + 入站唤醒
│   ├── discovery.js       # UDP 组播被动发现 + 地址分类 + 对端注册表 + 过期清理
│   ├── scan.js            # 主动扫描（端口池 + CIDR 展开 + 地址预算）
│   ├── portpool.js        # 端口池回退（池内依次监听，全占才退随机）—— 单独可测
│   ├── peerlink.js        # 对端连接：候选地址换路、探测、派发（无 DSH 依赖）
│   ├── directfetch.js     # 直连 HTTP（node:http 实现，永不经过环境变量代理）
│   └── _selftest-*.mjs    # 独立回归测试
├── client/
│   └── client.js          # 浏览器侧：手写 bundle，无需打包工具
├── tools/
│   ├── scopecheck.py      # 静态检查：模块级函数漏收 applyUnsafe 注入的变量
│   ├── host-smoke.mjs     # 沙箱里真跑一遍 apply()（不用重启 DSH）
│   └── startup-check.mjs  # 集成：真跑 apply() + 启动扫描，盯未捕获异常
├── dev-setup.sh           # 隔离测试环境搭建
├── dev-boot.mjs           # 带模块解析器的测试启动器
└── README.md
```

---

## 本仓库的由来

这是 [`peng456/dsh-plugin-mesh`](https://github.com/peng456/dsh-plugin-mesh) 的私人分支，
在 `bccf68b` 基础上修了一批**局域网地址判定**的问题（原仓库上游未合并）：

| # | 问题 | 后果 |
|---|---|---|
| 1 | `expandCidr` 只支持 `/16~/32`，且配了 `scanRanges` 就跳过本机 /24 兜底 | 写 `100.64.0.0/10`（Tailscale 网段）会**静默扫 0 个地址**，无任何提示 |
| 2 | 选对外地址只看网卡名，`100.64.0.0/10`（RFC 6598 CGNAT）不是 RFC1918 | 广播哪个地址取决于 `os.networkInterfaces()` 枚举顺序；Windows 中文网卡名直接不匹配 |
| 3 | 回连只信对端自述的 `host`，实测可达的 `sourceAddress` 存而不用 | 对端换了网 / 新开 Tailscale 后，"两边都看得见对方却永远连不上" |
| 4 | `pingKnownPeers` 用自述地址覆盖 `sourceAddress` | 与注释宣称的"防伪造"相反，把唯一可信的地址弄丢 |
| 5 | IPv6 完全不处理 | Tailscale 的 `fd7a:115c:a1e0::/48` 被无视 |
| 6 | 出站请求用全局 `fetch`，`NODE_USE_ENV_PROXY=1` 时会被 `http_proxy` 代理 | `no_proxy` 无法表达 `100.64.0.0/10` → **单向发现**（对端能看见我，我看不见对端） |

修法与回归测试见 `lib/_selftest-address.mjs`、`lib/_selftest-peerlink.mjs`、
`lib/_selftest-e2e.mjs`、`lib/_selftest-proxy.mjs`（共 60 条断言），
外加 `tools/host-smoke.mjs`（15 条）与 `npm run smoke`。

