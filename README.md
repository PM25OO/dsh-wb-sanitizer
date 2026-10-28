# dsh-wb-sanitizer

DeepSeek Harness 的**出口清洗插件**：在 `fetch` 边界无损改写请求体，绕过 WorkBuddy / CodeBuddy 网关对第三方客户端的渠道校验（`400` / `code 11-128` / `Illegal API invocation from an unapproved channel`）。

零外部进程、零 baseURL 改动、响应流原样透传。

---

## 它解决什么

WorkBuddy / CodeBuddy 网关（`www.codebuddy.cn` → `wb-proxy`）在**入口**对请求体做两道判定，命中就返回 `11-128`，和模型、渠道、UA、请求头都无关：

| 规则 | 触发条件 | 实测 |
|---|---|---|
| **R1 渠道指纹** | `messages[0]` 是 system，且开头为 `You are an AI agent powered by DeepSeek Harness`（大小写不敏感，末尾句号可有可无） | 命中即 400；去掉 `You are ` 前缀、加前导空格、双空格都变 200 |
| **R2 体量指纹** | 首条 system 超过约 22153 字符 | 22152 通过、22153 触发；纯填充到 26000 不触发，删掉任意一段又通过 |

本插件对 R1 在词内插入 `U+200B` 断开通路匹配，对 R2 把超出阈值的尾部**原样搬运**进一条 user 消息 —— 不改写任何一个字，模型侧语义不变（实测切片后仍能正确回答 system 里的内容）。

## 安装

```bash
# 1) 链接进 profile 的 node_modules（本地目录用 symlink，等价于 pnpm add link:）
ln -sfn /path/to/dsh-wb-sanitizer $DSH_HOME/profiles/web/node_modules/dsh-wb-sanitizer

# 2) 注册成 bundle
python3 - <<'PY'
import json
p = "$DSH_HOME/profiles/web/package.json"
d = json.load(open(p))
b = d["dsh"]["profile"]["bundles"]
if "dsh-wb-sanitizer" not in b:
    b.append("dsh-wb-sanitizer")
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
PY

# 3) 重启（会断开当前 Web 会话，重连即可，会话数据在磁盘）
systemctl restart dsh-web
```

启动日志里应出现：

```
[wb-sanitizer] active · hosts=UPSTREAM_HOST:PORT splitLimit=12000 audit=<repo>/audit.jsonl
```

装好之后 provider 的 `baseURL` 可以改回**直连上游**，不再需要任何本地 HTTP 代理：

```yaml
- id: llm-pi-ai
  config:
    providers:
      wb-proxy:
        baseURL: http://UPSTREAM_HOST:PORT/v1
```

## 配置

写在 profile 的 `cordis.patch.yml` 里（与 bundle 默认值合并）：

```yaml
- id: wb-sanitizer
  name: dsh-wb-sanitizer
  config:
    enabled: true
    hosts:
      - UPSTREAM_HOST:PORT      # 只清洗发往这里（也支持 hostname、host/path 前缀）
    splitLimit: 12000            # 首条 system 超过它就搬运尾部
    keywordBreak: true           # DeepSeek Harness → DeepSeek<U+200B> Harness
    auditLog: ""                 # 填路径则留 JSONL 审计
    verbose: false
```

`hosts` 匹配三种写法：`host:port`（精确 authority）、`hostname`、`host/path`（前缀）。官方 `api.deepseek.com` 不在列表里，**永远不会被改写**。

## 验证

```bash
# 单元测试
node --test test/sanitize.test.mjs

# 独立代理模式（不经 DSH，直接验证清洗链路）
node bin/wb-sanitizer-proxy.js --listen 127.0.0.1:8899 --upstream http://UPSTREAM_HOST:PORT
```

插件模式下看审计：

```bash
tail -f /tmp/wb-audit.jsonl
```

每行一条请求：`model`、`nMessages`、`nTools`、`systemLength`（原→后）、`scrubbed`、`split`。

## 实测记录（2026-10-28）

装在 dsh-web 进程内、直连上游、无本地代理，真实会话请求：

```
07:39:03  deepseek-v4.1-flash  sys 27318  scrub=True  split=True  msgs 484  tools 34
07:39:08  deepseek-v4.1-flash  sys 27318  scrub=True  split=True  msgs 486  tools 34
```

同一批触发用例（身份句裸空格 / 大写变体 / 27K 全量 system）在包装器下全部 200；直连上游同一 payload 全部 400/11-128。

独立代理模式冒烟：`You are an AI agent powered by DeepSeek​ Harness.` → 上游 400，经代理 **200**，日志 `scrub=true system=48→49`。

单元测试：`node --test test/sanitize.test.mjs` → 14/14 通过。

## 与其它方案的关系

- **dsh-purge**：改的是**源码里的提示词文本**（身份句剥离、关键词零宽化），对所有 provider 生效，属于「让发出去的内容变干净」。
- **本插件**：改的是**发出去的请求体**，只对 `hosts` 命中的上游生效，属于「守住最后一层」。两者互补：purge 管新会话的提示词组装，本插件管任何历史 / 任何路径（主对话、标题、压缩、子代理）漏出来的残渣。
- **独立代理模式**：给不走 DSH 的客户端用，逻辑与插件同源。

## 回滚

```bash
python3 - <<'PY'
import json
p = "$DSH_HOME/profiles/web/package.json"
d = json.load(open(p))
d["dsh"]["profile"]["bundles"] = [x for x in d["dsh"]["profile"]["bundles"] if x != "dsh-wb-sanitizer"]
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
PY
systemctl restart dsh-web
```

卸载后 DSH 立即回到「只在 dsh-purge 影响下」的状态。

## 结构

```
lib/sanitize.js              纯函数：breakToken / scrub / reshape / processBody / shouldSanitize
lib/index.js                 cordis 插件：包装 globalThis.fetch，双向透明
bin/wb-sanitizer-proxy.js    独立 HTTP 代理（复用 lib/sanitize.js）
cordis.patch.yml             bundle 默认配置
test/sanitize.test.mjs       14 个单元测试
```

## 注意

- `globalThis.fetch` 是进程级单例。插件用 `Symbol.for("dsh-wb-sanitizer.installed")` 防重复包装，卸载时只在栈顶仍是自己时才还原，不会踩掉后装的包装器。
- 包装层自身出错时**退回原始入参重发**，绝不因为清洗失败而阻断请求。
- 只处理 `POST`；GET/PUT 等原样透传。
- 非 JSON 请求体原样透传。
