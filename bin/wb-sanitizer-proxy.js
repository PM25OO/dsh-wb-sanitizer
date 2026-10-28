#!/usr/bin/env node
/**
 * 独立 HTTP 代理模式（不依赖 DSH 进程）。
 *
 * 用途：给不走 DSH 的客户端、或者需要在 DSH 之外单独验证时使用。
 * 清洗逻辑与插件完全同源，都是 lib/sanitize.js。
 *
 *   node bin/wb-sanitizer-proxy.js --listen 127.0.0.1:8899 --upstream http://UPSTREAM_HOST:PORT
 *
 * 环境变量同名：WB_SAN_LISTEN / WB_SAN_UPSTREAM / WB_SAN_SPLIT_LIMIT / WB_SAN_AUDIT
 */

import { createServer } from "node:http";
import { appendFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { DEFAULT_SPLIT_LIMIT, CARRY_PREFIX, processBody } from "../lib/sanitize.js";

const args = process.argv.slice(2);
function argOf(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const LISTEN = argOf("--listen", process.env.WB_SAN_LISTEN || "127.0.0.1:8899");
const UPSTREAM = (argOf("--upstream", process.env.WB_SAN_UPSTREAM || "http://127.0.0.1:8080")).replace(/\/$/, "");
const SPLIT_LIMIT = Number(argOf("--split-limit", process.env.WB_SAN_SPLIT_LIMIT || String(DEFAULT_SPLIT_LIMIT)));
const AUDIT = argOf("--audit", process.env.WB_SAN_AUDIT || "");

const [bindHost, bindPort] = LISTEN.split(":");
const upstreamUrl = new URL(UPSTREAM);
const relay = upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest;

const HOP = new Set([
  "host", "content-length", "accept-encoding", "connection", "transfer-encoding",
  "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade",
]);

const state = { seen: 0, changed: 0, scrubbed: 0, split: 0 };

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = raw;

    if (req.method === "POST" && raw) {
      const result = processBody(raw, { splitLimit: SPLIT_LIMIT, carryPrefix: CARRY_PREFIX });
      state.seen += 1;
      if (result.changed) {
        state.changed += 1;
        if (result.scrubbed) state.scrubbed += 1;
        if (result.split) state.split += 1;
        body = result.body;
      }
      const s = result.stats || {};
      log(
        `${req.method} ${req.url} -> model=${s.model ?? "?"} scrub=${result.scrubbed} ` +
          `split=${result.split} system=${s.originalSystemLength ?? "?"}→${s.systemLength ?? "?"}`,
      );
      if (AUDIT) {
        void appendFile(
          AUDIT,
          JSON.stringify({
            t: new Date().toISOString(),
            url: req.url,
            model: s.model,
            nMessages: s.nMessages,
            nTools: s.nTools,
            systemLength: s.originalSystemLength ?? s.systemLength,
            scrubbed: result.scrubbed,
            split: result.split,
            changed: result.changed,
          }) + "\n",
          "utf8",
        ).catch(() => {});
      }
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP.has(k.toLowerCase())) headers[k] = v;
    }
    if (body) headers["content-length"] = String(Buffer.byteLength(body));

    const upstream = relay(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
        path: upstreamUrl.pathname.replace(/\/$/, "") + req.url,
        method: req.method,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => {
      log(`upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`wb-sanitizer: upstream error: ${err.message}`);
    });
    if (body) upstream.write(body);
    upstream.end();
  });
});

function log(msg) {
  process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] [wb-sanitizer] ${msg}\n`);
}

server.listen(Number(bindPort), bindHost, () => {
  log(`listening on ${LISTEN} -> ${UPSTREAM} (splitLimit=${SPLIT_LIMIT})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`stop after seen=${state.seen} changed=${state.changed} scrub=${state.scrubbed} split=${state.split}`);
    server.close(() => process.exit(0));
  });
}
