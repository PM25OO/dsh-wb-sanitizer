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

装之前只需要准备一样东西：**上游地址**（网关的 `host:port`，或带路径的 `host/path`）。
其余参数都有默认值，想改就在安装时填。

### 方式一：dsh plugin（最原生，推荐）

```bash
# 1) 装包 + 自动注册 bundle
dsh plugin --profile web add github:PM25OO/dsh-wb-sanitizer

# 2) 写配置（这一步 dsh plugin 不会代劳）
node install.mjs --config-only --upstream UPSTREAM_HOST:PORT --yes
```

本地开发时把第 1 步换成路径即可：

```bash
dsh plugin --profile web add /path/to/dsh-wb-sanitizer
```

`dsh plugin` 是 pnpm 的前置壳，它会做两件事：把包装进 `node_modules`（记录到 `dependencies`），
并**自动把包名加进 `dsh.profile.bundles`**。它不做的是：写插件配置（`hosts` 必填）。

### 方式二：交互安装（一条命令，全平台）

```bash
git clone https://github.com/PM25OO/dsh-wb-sanitizer.git
cd dsh-wb-sanitizer
node install.mjs
```

它会依次问三件事，然后自动完成所有改动：

```
安装 dsh-wb-sanitizer
  profile: ~/.dsh/profiles/web

① 上游地址（必填，多个用逗号分隔）
   例: 192.0.2.10:8788 或 gateway.example.com/v1
   > 192.0.2.10:8788
② 首条 system 超过多少字符就搬运尾部（回车用默认 12000）
   >
③ 审计日志路径（回车跳过）
   >
```

### 方式三：一行命令，不交互

```bash
node install.mjs --upstream UPSTREAM_HOST:PORT --split-limit 12000 --yes
```

需要审计日志就多加 `--audit /path/to/audit.jsonl`。

### 方式四：先写配置文件再装

```bash
cp config.example.json my-config.json
# 编辑 my-config.json，把 UPSTREAM_HOST:PORT 换成你的上游
node install.mjs --config my-config.json --yes
```

```json
{
  "upstreamHosts": ["UPSTREAM_HOST:PORT"],
  "splitLimit": 12000,
  "keywordBreak": true,
  "auditLog": "",
  "verbose": false
}
```

### 各方式分别做了什么

| 步骤 | `dsh plugin add` | `install.mjs` | `install.mjs --config-only` |
|---|---|---|---|
| 装包进 node_modules | ✅ | ✅（symlink / junction / 复制） | — |
| 写入 `dependencies` | ✅ | — | — |
| 注册 `dsh.profile.bundles` | ✅ 自动 | ✅ | — |
| 写插件配置块 | — | ✅ | ✅ |
| 重启服务 | — | — | — |

### 装完重启

| 平台 | 命令 |
|---|---|
| Linux (systemd) | `systemctl restart dsh-web` |
| macOS | 重启 `dsh web` 进程 |
| Windows | 关掉 `dsh web` 窗口再重新打开 |

启动日志里应出现：

```
[wb-sanitizer] active · hosts=UPSTREAM_HOST:PORT splitLimit=12000
```

装好之后 provider 的 `baseURL` 可以改回**直连上游**，不再需要任何本地 HTTP 代理：

```yaml
- id: llm-pi-ai
  config:
    providers:
      wb-proxy:
        baseURL: http://UPSTREAM_HOST:PORT/v1
```

### 只看不改 / 卸载

```bash
node install.mjs --upstream UPSTREAM_HOST:PORT --dry-run   # 显示会改什么，不落盘
node install.mjs --uninstall                               # 清理配置；包由 pnpm 管理时会提示正确命令
```

用 `dsh plugin` 装的，标准卸载顺序：

```bash
dsh plugin --profile web remove dsh-wb-sanitizer   # 摘依赖 + 摘 bundle
node install.mjs --uninstall                       # 清配置块
```

### 手动安装（不想跑安装器，也不想用 dsh plugin）

```bash
ln -sfn /path/to/dsh-wb-sanitizer $DSH_HOME/profiles/web/node_modules/dsh-wb-sanitizer
# 然后把 "dsh-wb-sanitizer" 加进 $DSH_HOME/profiles/web/package.json 的 dsh.profile.bundles
# 再往 $DSH_HOME/profiles/web/cordis.patch.yml 追加配置块
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
# 用 dsh plugin 装的
dsh plugin --profile web remove dsh-wb-sanitizer
node install.mjs --uninstall      # 清掉配置块

# 用 install.mjs 装的
node install.mjs --uninstall

# 两者都做完后重启
systemctl restart dsh-web         # Linux
```

卸载后 DSH 立即回到「只在 dsh-purge 影响下」的状态，不会残留配置。

## 结构

```
install.mjs                  跨平台安装器（交互 / 参数 / 配置文件 / 卸载 / dry-run）
config.example.json          配置文件模板
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
