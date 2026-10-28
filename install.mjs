#!/usr/bin/env node
/**
 * dsh-wb-sanitizer 安装器（跨平台：Linux / macOS / Windows）。
 *
 * 设计目标：**装之前就把配置填好**。运行后按提示回答几个问题，
 * 安装器负责把包放进 profile、注册 bundle、写好配置，最后告诉你重启命令。
 *
 *   node install.mjs                     交互安装
 *   node install.mjs --upstream HOST:PORT --yes     非交互
 *   node install.mjs --config my.json    从配置文件读
 *   node install.mjs --uninstall         卸载
 *   node install.mjs --dry-run           只看会改什么，不落盘
 *
 * 重复运行是安全的：配置块由标记托管，卸载后不留残渣。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const PKG_NAME = "dsh-wb-sanitizer";
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const BLOCK_BEGIN = "# >>> dsh-wb-sanitizer >>>";
const BLOCK_END = "# <<< dsh-wb-sanitizer <<<";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f, d = undefined) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const HELP = `
dsh-wb-sanitizer 安装器

用法:
  node install.mjs                       交互安装（推荐）
  node install.mjs --upstream H:PORT     直接指定上游
  node install.mjs --config FILE         从 JSON 配置文件读取
  node install.mjs --uninstall           卸载
  node install.mjs --dry-run             只显示将要做的改动

选项:
  --upstream <h:p[,h:p...]>   上游地址，逗号分隔；支持 host:port / hostname / host/path
  --split-limit <n>           首条 system 超过多少字符就搬运尾部（默认 12000）
  --audit <file>              审计日志路径，留空不写
  --profile <name>            DSH profile 名（默认 web）
  --dsh-home <dir>            DSH 主目录（默认 $DSH_HOME 或 ~/.dsh）
  --no-keyword                不做关键词断开（只做体量搬运）
  --yes, -y                   非交互，缺的配置用默认值
  --help, -h                  显示本帮助
`;

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✔ ${msg}`);
}

function info(msg) {
  console.log(`  ${msg}`);
}

/** 解析 DSH 主目录：--dsh-home > $DSH_HOME > ~/.dsh */
function resolveDshHome(explicit) {
  const dir = explicit || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.resolve(dir);
}

/** 读 JSON，失败返回 null。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 把包放进 profile 的 node_modules：先试 symlink/junction，失败则复制。 */
function linkPackage(profileDir, dryRun) {
  const dest = path.join(profileDir, "node_modules", PKG_NAME);
  const kind = process.platform === "win32" ? "junction" : "dir";
  if (dryRun) return { dest, mode: "symlink" };

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.rmSync(dest, { recursive: true, force: true });
  } catch {
    /* 旧链接可能指向不存在的目标，忽略 */
  }

  try {
    fs.symlinkSync(SELF_DIR, dest, kind);
    return { dest, mode: "symlink" };
  } catch {
    fs.cpSync(SELF_DIR, dest, {
      recursive: true,
      filter: (src) => !/[\\/](\.git|node_modules|audit\.jsonl)$/.test(src),
    });
    return { dest, mode: "copy" };
  }
}

/** 在 profile package.json 的 bundles 里登记插件。 */
function registerBundle(profileDir, dryRun) {
  const file = path.join(profileDir, "package.json");
  const manifest = readJson(file);
  if (!manifest) throw new Error(`读不到 ${file}`);
  const profile = (manifest.dsh ??= {}).profile ??= {};
  const bundles = (profile.bundles ??= []);
  if (!Array.isArray(bundles)) throw new Error(`${file} 里的 dsh.profile.bundles 不是数组`);

  const already = bundles.includes(PKG_NAME);
  if (!already) bundles.push(PKG_NAME);
  if (!dryRun && !already) fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return { file, already };
}

/** 从 profile package.json 摘掉插件。 */
function unregisterBundle(profileDir, dryRun) {
  const file = path.join(profileDir, "package.json");
  const manifest = readJson(file);
  if (!manifest) return false;
  const bundles = manifest.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.includes(PKG_NAME)) return false;
  manifest.dsh.profile.bundles = bundles.filter((x) => x !== PKG_NAME);
  if (!dryRun) fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return true;
}

/** 生成配置块。 */
function configBlock(cfg) {
  const hosts = cfg.upstreamHosts.map((h) => `      - ${h}`).join("\n");
  return [
    BLOCK_BEGIN,
    "# 由 install.mjs 生成，重复安装会整块替换；手工改动请写在块外。",
    "- id: wb-sanitizer",
    `  name: ${PKG_NAME}`,
    "  config:",
    "    enabled: true",
    "    hosts:",
    hosts,
    `    splitLimit: ${cfg.splitLimit}`,
    `    keywordBreak: ${cfg.keywordBreak}`,
    `    auditLog: ${JSON.stringify(cfg.auditLog || "")}`,
    `    verbose: ${cfg.verbose}`,
    BLOCK_END,
    "",
  ].join("\n");
}

/** 把托管块写进（或替换进）cordis.patch.yml。 */
function writeConfigBlock(profileDir, cfg, dryRun) {
  const file = path.join(profileDir, "cordis.patch.yml");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = "";
  }

  let next;
  const begin = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (begin >= 0 && end > begin) {
    next = text.slice(0, begin) + configBlock(cfg) + text.slice(end + BLOCK_END.length + 1);
  } else {
    // 没有托管块：先删掉可能存在的同名手工条目，再追加
    next = stripManualEntry(text) + (text.trim() ? "\n" : "") + configBlock(cfg);
  }

  if (!dryRun) fs.writeFileSync(file, next, "utf8");
  return file;
}

/** 删掉形如 `- id: wb-sanitizer` 的手工条目（到下一个顶层条目为止）。 */
function stripManualEntry(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^-\s+id:\s*wb-sanitizer\s*$/.test(lines[i])) {
      i += 1;
      while (i < lines.length && !/^-\s/.test(lines[i])) i += 1;
      i -= 1;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

/** 移除托管块与条目。 */
function removeConfig(profileDir, dryRun) {
  const file = path.join(profileDir, "cordis.patch.yml");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const begin = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  let next = text;
  if (begin >= 0 && end > begin) {
    next = text.slice(0, begin) + text.slice(end + BLOCK_END.length + 1);
  }
  next = stripManualEntry(next).replace(/\n{3,}/g, "\n\n");
  const changed = next !== text;
  if (!dryRun && changed) {
    // 清空后不留空文件：空 YAML 会被解析成 null，不如直接删掉。
    if (next.trim() === "") fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, next, "utf8");
  }
  return changed;
}

function normalizeHosts(raw) {
  return String(raw || "")
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

async function main() {
  if (has("--help") || has("-h")) {
    console.log(HELP);
    return;
  }

  const dryRun = has("--dry-run");
  const yes = has("--yes") || has("-y");
  const uninstall = has("--uninstall");
  const dshHome = resolveDshHome(valOf("--dsh-home"));
  const profileName = valOf("--profile", "web");
  const profileDir = path.join(dshHome, "profiles", profileName);

  if (!fs.existsSync(profileDir)) {
    fail(
      `找不到 profile 目录: ${profileDir}\n` +
        `  先启动一次 DSH 让它生成 profile（例如运行 \`dsh web\`），再回来执行本安装器。\n` +
        `  如果 DSH 主目录不在默认位置，用 --dsh-home 指定。`,
    );
  }

  if (dryRun) console.log("\n【dry-run】只显示改动，不写任何文件\n");

  // ---------- 卸载 ----------
  if (uninstall) {
    console.log(`卸载 ${PKG_NAME}`);
    info(`profile: ${profileDir}`);
    const dest = path.join(profileDir, "node_modules", PKG_NAME);
    if (fs.existsSync(dest) && !dryRun) fs.rmSync(dest, { recursive: true, force: true });
    ok(`移除 node_modules/${PKG_NAME}`);
    const removed = unregisterBundle(profileDir, dryRun);
    ok(removed ? "从 dsh.profile.bundles 摘除" : "bundles 里本来就没有");
    const cfgRemoved = removeConfig(profileDir, dryRun);
    ok(cfgRemoved ? "清理 cordis.patch.yml 配置" : "cordis.patch.yml 无相关配置");
    console.log("\n重启 DSH 生效：\n  systemctl restart dsh-web   # Linux\n  重启 dsh web                # macOS / Windows\n");
    return;
  }

  // ---------- 收集配置 ----------
  const fileCfg = has("--config") ? readJson(valOf("--config")) : null;
  if (has("--config") && !fileCfg) fail(`读不到配置文件: ${valOf("--config")}`);

  const cfg = {
    upstreamHosts: normalizeHosts(
      valOf("--upstream") ?? (fileCfg?.upstreamHosts ?? []).join(","),
    ),
    splitLimit: Number(valOf("--split-limit", fileCfg?.splitLimit ?? 12000)),
    keywordBreak: has("--no-keyword") ? false : (fileCfg?.keywordBreak ?? true),
    auditLog: valOf("--audit", fileCfg?.auditLog ?? ""),
    verbose: fileCfg?.verbose ?? false,
  };

  const interactive = process.stdin.isTTY && !yes;

  if (interactive) {
    console.log(`\n安装 ${PKG_NAME}`);
    console.log(`  profile: ${profileDir}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    /** 读一行；stdin 结束（Ctrl+D）返回 null，不抛异常。 */
    const ask = async (q) => {
      try {
        return await rl.question(q);
      } catch {
        return null;
      }
    };
    try {
      while (cfg.upstreamHosts.length === 0) {
        const answer = await ask(
          "① 上游地址（必填，多个用逗号分隔）\n   例: 192.0.2.10:8788 或 gateway.example.com/v1\n   > ",
        );
        if (answer === null) break;
        cfg.upstreamHosts = normalizeHosts(answer);
        if (cfg.upstreamHosts.length === 0) console.log("   需要一个地址，比如 192.0.2.10:8788\n");
      }

      if (cfg.upstreamHosts.length > 0) {
        const limit = await ask(
          `② 首条 system 超过多少字符就搬运尾部（回车用默认 ${cfg.splitLimit}）\n   > `,
        );
        if (limit && limit.trim()) {
          const n = Number(limit.trim());
          if (!Number.isFinite(n) || n <= 0) fail("splitLimit 必须是正整数");
          cfg.splitLimit = n;
        }

        const audit = await ask("③ 审计日志路径（回车跳过）\n   > ");
        if (audit && audit.trim()) cfg.auditLog = audit.trim();
      }
    } finally {
      rl.close();
    }
    if (cfg.upstreamHosts.length === 0) {
      fail("没有拿到上游地址。也可以用非交互方式：node install.mjs --upstream HOST:PORT --yes");
    }
  } else if (cfg.upstreamHosts.length === 0) {
    fail(
      "缺少 --upstream。用法示例：\n" +
        "  node install.mjs --upstream 192.0.2.10:8788 --yes\n" +
        "  或交互运行：node install.mjs",
    );
  }

  if (!Number.isFinite(cfg.splitLimit) || cfg.splitLimit <= 0) fail("splitLimit 必须是正整数");

  // ---------- 执行安装 ----------
  console.log("");
  const link = linkPackage(profileDir, dryRun);
  ok(`${dryRun ? "将" : "已"}放置包 → ${link.dest}（${link.mode}）`);

  const reg = registerBundle(profileDir, dryRun);
  ok(
    reg.already
      ? "bundle 已在 dsh.profile.bundles 中"
      : `${dryRun ? "将" : "已"}登记 bundle → dsh.profile.bundles`,
  );

  const cfgFile = writeConfigBlock(profileDir, cfg, dryRun);
  ok(`${dryRun ? "将" : "已"}写入配置 → ${cfgFile}`);
  info(`hosts: ${cfg.upstreamHosts.join(", ")}`);
  info(`splitLimit: ${cfg.splitLimit} · keywordBreak: ${cfg.keywordBreak}`);
  if (cfg.auditLog) info(`auditLog: ${cfg.auditLog}`);

  if (dryRun) {
    console.log("\n【dry-run】以上改动未落盘。去掉 --dry-run 正式执行。\n");
    return;
  }

  console.log(`
下次启动 DSH 时生效。重启命令：

  Linux (systemd)   systemctl restart dsh-web
  macOS            重启 dsh web 进程
  Windows          重启 dsh web（关掉窗口再开）

启动日志里应出现：
  [wb-sanitizer] active · hosts=${cfg.upstreamHosts.join(",")} splitLimit=${cfg.splitLimit}

确认清洗是否发生：
  ${cfg.auditLog ? `tail -f ${cfg.auditLog}` : "在配置里填 auditLog 路径后可用审计日志核对"}
`);
}

main().catch((error) => fail(error?.stack || String(error)));
