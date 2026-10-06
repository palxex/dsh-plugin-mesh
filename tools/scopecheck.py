"""
只适用于 lib/index.js（主机侧）：那里有 applyUnsafe 把一批局部变量
解构传给若干模块级 helper，漏传就是运行时 ReferenceError。
client/client.js 结构不同，本脚本对它没有意义（会报 0 个函数）。

针对本插件最易犯的错误：模块级函数引用了 applyUnsafe 里的局部变量，
却没通过解构参数接收。

词汇表由两部分合成：
  1. applyUnsafe 里 startPeerServer/registerTools/registerUiRoutes/setupInbound
     的解构键（"已知会被传下去的"）
  2. applyUnsafe **顶层**声明的局部变量（const/let/var）

第 2 条是 2026-10 补的：原来只看第 1 条，于是新加一个局部变量（比如
`const announce = resolveAnnounceAddress(config)`）却忘了加进解构列表时，
脚本什么都查不出来 —— 而那正是 ReferenceError。这条由 tools/host-smoke.mjs
在运行时兜底，但静态检查更早、更便宜。
"""
import re, sys

src = open(sys.argv[1], encoding='utf-8').read()


# 去注释/字符串，避免噪声
def strip_noise(s):
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c == '/' and i + 1 < n and s[i + 1] == '/':
            j = s.find('\n', i); i = n if j < 0 else j
        elif c == '/' and i + 1 < n and s[i + 1] == '*':
            j = s.find('*/', i + 2); i = n if j < 0 else j + 2
        elif c in '"\'`':
            q = c; i += 1
            while i < n and s[i] != q:
                i += 2 if s[i] == '\\' else 1
            i += 1
        else:
            out.append(c); i += 1
    return ''.join(out)


def brace_body(s, start):
    """返回 s[start]（'{'）对应右花括号的下标。"""
    d, i, n = 0, start, len(s)
    while i < n:
        if s[i] == '{': d += 1
        elif s[i] == '}':
            d -= 1
            if d == 0: return i
        i += 1
    return n


def top_level_decls(body):
    """body 里**最外层**声明的变量名（不进入嵌套块，避免把回调里的临时变量算进来）。

    body 含最外层的花括号，所以 depth 从 -1 起算：外层的 `{` 恰好把它抬到 0，
    嵌套块的 `{` 再抬到 1 以上，于是只有真正位于函数体顶层的那批声明被收进来。
    """
    names, depth = set(), -1
    for m in re.finditer(r'[{}]|\b(?:const|let|var)\s+([\w$]+)', body):
        tok = m.group(0)
        if tok == '{':
            depth += 1
        elif tok == '}':
            depth -= 1
        elif depth == 0 and m.group(1):
            names.add(m.group(1))
    return names


clean = strip_noise(src)

# 1) 注入词汇表：各 helper 的解构键
vocab = set()
for m in re.finditer(r'\b(?:startPeerServer|registerTools|registerUiRoutes|setupInbound)\s*\(\s*ctx\s*,\s*\{([^}]*)\}', clean):
    for k in m.group(1).split(','):
        k = k.strip().split(':')[0].strip()
        if k: vocab.add(k)
vocab.discard('ctx')

# 2) applyUnsafe 顶层的局部变量
apply_m = re.search(r'^function\s+applyUnsafe\s*\([^)]*\)\s*\{', clean, re.M)
apply_body = ''
if apply_m:
    apply_body = clean[apply_m.end() - 1:brace_body(clean, apply_m.end() - 1)]
    vocab |= top_level_decls(apply_body)
vocab.discard('ctx')

problems, checked = [], 0
for m in re.finditer(r'^(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)\s*\{', clean, re.M):
    fname, params_raw = m.group(1), m.group(2)
    if fname == 'applyUnsafe': continue
    brace = m.end() - 1
    body = clean[brace:brace_body(clean, brace)]

    params = set()
    # 把解构花括号当分隔符，再按逗号切：同时覆盖普通参数和解构键
    for p in re.sub(r'[{}]', ' ', params_raw).split(','):
        p = p.strip().split(':')[0].strip().split('=')[0].strip()
        if re.fullmatch(r'[\w$]+', p): params.add(p)
    # 函数自己声明的同名局部变量也算"已接收"（否则会误报）
    for dm in re.finditer(r'\b(?:const|let|var|function)\s+([\w$]+)', body):
        params.add(dm.group(1))

    # 该函数引用了哪些"词汇表"里的名字。
    # 排除 `name:` 形式 —— 那是对象字面量的键（`{ instanceId: discovery.instanceId }`），
    # 不是变量引用，否则会误报。
    referenced = {
        v for v in vocab
        if re.search(r'(?<![.\w$])' + re.escape(v) + r'\b(?!\s*:)', body)
    }
    if not referenced: continue
    checked += 1
    missing = sorted(referenced - params)
    if missing:
        line = clean[:m.start()].count('\n') + 1
        problems.append((line, fname, missing))

print(f'词汇表（applyUnsafe 注入/声明的局部变量）: {", ".join(sorted(vocab))}\n')
for line, fname, miss in sorted(problems):
    print(f'  ❌ {fname}() 引用了但未接收: {", ".join(miss)}')
if problems:
    sys.exit(1)
print(f'  ✅ 检查了 {checked} 个函数，引用全部在解构参数内')
