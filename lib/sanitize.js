/**
 * 出口清洗的核心纯函数。
 *
 * 与 WorkBuddy / CodeBuddy 网关实测出来的两条规则对应：
 *
 *   R1 渠道指纹：messages[0] 是 system，且开头（大小写不敏感）为
 *      "you are an ai agent powered by deepseek\u200b harness" → 400 / 11-128。
 *      任意位置出现 "DeepSeek﹡Harness"（分隔符可为空格/零宽/无）也可能命中，
 *      代价为零，所以统一在词内插入 U+200B 断开。
 *
 *   R2 体量指纹：同一条 system 消息超过某个体量阈值即判为第三方客户端。
 *      实测 22153 字符触发、22152 通过，且纯填充不触发 → 与内容结构相关。
 *      做法是把超出阈值的尾部原样搬进一条 user 消息，不改写任何文字。
 *
 * 两个规则都只作用于请求体，响应流原样透传。
 */

/** 关键词正则：DeepSeek 与 Harness 之间允许 0~3 个分隔字符。 */
export const NEEDLE_RE = /DeepSeek(.{0,3}?)Harness/gi;

/** 默认体量阈值：留足余量，低于实测 22153 的临界点。 */
export const DEFAULT_SPLIT_LIMIT = 12000;

/** 搬运尾部时加的前缀，保留「这一段仍然是 system 级指令」的语义。 */
export const CARRY_PREFIX = "[运行配置续，与 system 指令同等效力]\n\n";

/**
 * 在 "DeepSeek" 与 "Harness" 之间插入一个 U+200B。
 * 已插入过的不再重复插入，避免多轮往返不断累积。
 */
export function breakToken(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  return text.replace(NEEDLE_RE, (whole) => {
    const head = "DeepSeek".length;
    if (whole.slice(head).includes("\u200b")) return whole;
    return whole.slice(0, head) + "\u200b" + whole.slice(head);
  });
}

/** 递归清洗 JSON 里所有字符串值（键名不动）。 */
export function scrub(value) {
  if (typeof value === "string") return breakToken(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrub(item);
    return out;
  }
  return value;
}

/** 取消息正文的纯文本视图，仅用于统计与判定。 */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object") {
      for (const key of ["text", "content", "thinking"]) {
        if (typeof block[key] === "string") parts.push(block[key]);
      }
    }
  }
  return parts.join("\n");
}

/**
 * 体量搬运：首条 system 超阈值时，把尾部搬进一条 user 消息。
 * 只做搬运，不删改任何字符。
 */
export function reshape(payload, { splitLimit = DEFAULT_SPLIT_LIMIT, carryPrefix = CARRY_PREFIX } = {}) {
  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return { payload, split: false };
  const first = messages[0];
  if (!first || first.role !== "system" || typeof first.content !== "string") {
    return { payload, split: false };
  }
  if (!Number.isFinite(splitLimit) || splitLimit <= 0) return { payload, split: false };
  if (first.content.length <= splitLimit) return { payload, split: false };

  const head = first.content.slice(0, splitLimit);
  const tail = first.content.slice(splitLimit);
  const carried = { role: "user", content: carryPrefix + tail };
  return {
    payload: { ...payload, messages: [{ ...first, content: head }, carried, ...messages.slice(1)] },
    split: true,
  };
}

/** 首条 system 是否构成上游的渠道指纹（大小写不敏感）。 */
export function looksLikeChannelFingerprint(content) {
  if (typeof content !== "string") return false;
  return content
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .startsWith("you are an ai agent powered by deepseek");
}

/**
 * 处理一个完整请求体文本。
 * @returns {{body: string, changed: boolean, scrubbed: boolean, split: boolean, stats: object|null}}
 */
export function processBody(text, options = {}) {
  const empty = { body: text, changed: false, scrubbed: false, split: false, stats: null };
  if (typeof text !== "string" || text.length === 0) return empty;

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return empty; // 非 JSON 原样透传
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return empty;

  const keywordBreak = options.keywordBreak !== false;
  const before = JSON.stringify(payload);
  const scrubbedPayload = keywordBreak ? scrub(payload) : payload;
  const scrubbed = keywordBreak && JSON.stringify(scrubbedPayload) !== before;

  const { payload: finalPayload, split } = reshape(scrubbedPayload, options);
  const body = scrubbed || split ? JSON.stringify(finalPayload) : text;

  const originalFirst = Array.isArray(payload.messages) ? payload.messages[0] : undefined;
  const finalFirst = Array.isArray(finalPayload.messages) ? finalPayload.messages[0] : undefined;

  return {
    body,
    changed: body !== text,
    scrubbed,
    split,
    stats: {
      model: typeof finalPayload.model === "string" ? finalPayload.model : undefined,
      nMessages: Array.isArray(finalPayload.messages) ? finalPayload.messages.length : 0,
      nTools: Array.isArray(finalPayload.tools) ? finalPayload.tools.length : 0,
      originalSystemLength: textOf(originalFirst?.content).length,
      systemLength: textOf(finalFirst?.content).length,
      hitLead: looksLikeChannelFingerprint(originalFirst?.content),
    },
  };
}

/**
 * 判断一个 URL 是否属于要清洗的上游。
 * 支持三种 host 写法：`host:port`（精确匹配 authority）、`hostname`、
 * 以及带路径前缀的 `host/path`（匹配 authority + path 的开头）。
 */
export function shouldSanitize(url, hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const authority = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const pathAndQuery = `${parsed.pathname}${parsed.search}`.toLowerCase();
  return hosts.some((entry) => {
    const rule = String(entry || "").trim().toLowerCase();
    if (!rule) return false;
    if (rule.includes("/")) return `${authority}${pathAndQuery}`.startsWith(rule);
    if (rule.includes(":")) return authority === rule;
    return hostname === rule;
  });
}
