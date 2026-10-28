/**
 * dsh-wb-sanitizer —— DSH 出口清洗插件。
 *
 * 在 fetch 边界（也就是请求真正发出去的那一层）截获发往指定上游的
 * JSON 请求体，按 lib/sanitize.js 的两条规则做无损改写：
 *
 *   R1 关键词断开：DeepSeek\u200B Harness
 *   R2 超长 system 搬运：尾部搬进一条 user 消息
 *
 * 响应（含 SSE 流）原样透传，不缓冲、不改写。
 *
 * 之所以挂在 fetch 而不是改提示词或改 provider 配置：
 * 上游判定看的是「最终发出去的那份 JSON」，只有这一层能保证两者一致，
 * 且对所有 provider 路由、所有模型、所有调用路径（主对话 / 标题 / 压缩 /
 * 子代理）一次性生效。
 *
 * @module dsh-wb-sanitizer
 */

import { appendFile } from "node:fs/promises";

import {
  DEFAULT_SPLIT_LIMIT,
  CARRY_PREFIX,
  processBody,
  shouldSanitize,
} from "./sanitize.js";

export const name = "wb-sanitizer";

/** 默认清洗目标：空。必须由使用者在 profile 配置里填自己的上游地址。 */
export const DEFAULT_HOSTS = [];  // 必须显式配置：插件只清洗发往这些目标的请求

const MARK = Symbol.for("dsh-wb-sanitizer.installed");

/**
 * 安装 fetch 包装。返回卸载函数。
 *
 * 多个插件实例共享同一个全局 fetch，用 Symbol 标记避免重复包装；
 * 卸载时只在仍是我们这层时才还原，避免把后装的包装器踩掉。
 */
function installFetchWrapper(config, state) {
  const savedFetch = globalThis.fetch;
  if (typeof savedFetch !== "function") return () => {};
  if (savedFetch[MARK]) return () => {};

  const hosts = config.hosts;
  const splitLimit = config.splitLimit;
  const keywordBreak = config.keywordBreak;

  const wrapper = async function wbSanitizerFetch(input, init) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input && typeof input.url === "string"
            ? input.url
            : "";

    if (!url || !shouldSanitize(url, hosts)) return savedFetch(input, init);

    const method = String(init?.method ?? (input && input.method) ?? "GET").toUpperCase();
    if (method !== "POST") return savedFetch(input, init);

    let raw = null;
    if (typeof init?.body === "string") raw = init.body;
    else if (init?.body == null && input && typeof input.clone === "function") {
      try {
        raw = await input.clone().text();
      } catch {
        raw = null;
      }
    }
    if (typeof raw !== "string" || raw.length === 0) return savedFetch(input, init);

    let result;
    try {
      result = processBody(raw, {
        splitLimit,
        carryPrefix: config.carryPrefix,
        keywordBreak,
      });
    } catch {
      return savedFetch(input, init);
    }

    state.seen += 1;
    if (!result.changed) {
      if (config.auditLog) void writeAudit(config, state, url, result, false);
      return savedFetch(input, init);
    }

    state.changed += 1;
    if (result.scrubbed) state.scrubbed += 1;
    if (result.split) state.split += 1;
    if (config.auditLog) void writeAudit(config, state, url, result, true);
    if (config.verbose) {
      const s = result.stats || {};
      console.error(
        `[wb-sanitizer] ${url} model=${s.model ?? "?"} scrub=${result.scrubbed} split=${result.split} ` +
          `system=${s.originalSystemLength}→${s.systemLength}`,
      );
    }

    const nextInit = { ...(init || {}), body: result.body };
    try {
      return await savedFetch(url, nextInit);
    } catch (error) {
      // 包装层自身绝不吞掉请求：失败就退回原始入参再发一次。
      if (config.verbose) console.error(`[wb-sanitizer] retry original: ${error}`);
      return savedFetch(input, init);
    }
  };

  Object.defineProperty(wrapper, MARK, { value: true });

  globalThis.fetch = wrapper;
  return () => {
    if (globalThis.fetch === wrapper) globalThis.fetch = savedFetch;
  };
}

async function writeAudit(config, state, url, result, changed) {
  const s = result.stats || {};
  const row = {
    t: new Date().toISOString(),
    url,
    model: s.model,
    nMessages: s.nMessages,
    nTools: s.nTools,
    systemLength: s.originalSystemLength ?? s.systemLength,
    scrubbed: result.scrubbed,
    split: result.split,
    changed,
  };
  try {
    await appendFile(config.auditLog, JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* 审计失败不影响主链路 */
  }
}

export function apply(ctx, rawConfig) {
  const config = {
    enabled: true,
    hosts: DEFAULT_HOSTS,
    splitLimit: DEFAULT_SPLIT_LIMIT,
    carryPrefix: CARRY_PREFIX,
    keywordBreak: true,
    auditLog: "",
    verbose: false,
    ...(rawConfig || {}),
  };

  if (!config.enabled) {
    if (config.verbose) console.error("[wb-sanitizer] disabled by config");
    return;
  }
  if (!Array.isArray(config.hosts) || config.hosts.length === 0) {
    console.error("[wb-sanitizer] hosts 为空，插件不做任何事");
    return;
  }

  const state = { seen: 0, changed: 0, scrubbed: 0, split: 0 };
  const dispose = installFetchWrapper(config, state);

  ctx.effect(() => () => {
    dispose();
    if (config.verbose) {
      console.error(
        `[wb-sanitizer] disposed after seen=${state.seen} changed=${state.changed} ` +
          `scrub=${state.scrubbed} split=${state.split}`,
      );
    }
  }, "wb-sanitizer.fetch");

  console.error(
    `[wb-sanitizer] active · hosts=${config.hosts.join(",")} splitLimit=${config.splitLimit}` +
      `${config.auditLog ? ` audit=${config.auditLog}` : ""}`,
  );
}
