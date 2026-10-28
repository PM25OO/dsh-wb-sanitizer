import { test } from "node:test";
import assert from "node:assert/strict";

import {
  breakToken,
  looksLikeChannelFingerprint,
  processBody,
  reshape,
  scrub,
  shouldSanitize,
  textOf,
} from "../lib/sanitize.js";

// 用拼接构造，避免源码里肉眼不可见的字符造成误判。
const ZW = "\u200b";
const SP = " ";
const BARE = "DeepSeek" + SP + "Harness"; // 裸空格
const BROKEN = "DeepSeek" + ZW + " Harness"; // 已断开

test("breakToken 断开大小写与各种分隔符", () => {
  assert.equal(breakToken(BARE), BROKEN);
  assert.equal(breakToken("SEE DEEPSEEK" + SP + "HARNESS"), "SEE DEEPSEEK" + ZW + " HARNESS");
  assert.equal(breakToken("deepseek" + SP + "harness"), "deepseek" + ZW + " harness");
  assert.equal(breakToken("deepseek" + ZW + "harness"), "deepseek" + ZW + "harness");
});

test("breakToken 幂等：已断开的不再叠加", () => {
  const once = breakToken(BARE);
  assert.equal(breakToken(once), once);
  assert.equal(once.split(ZW).length - 1, 1);
});

test("breakToken 不动无关文本", () => {
  assert.equal(breakToken("You are a helpful assistant."), "You are a helpful assistant.");
  assert.equal(breakToken(""), "");
});

test("scrub 递归处理数组与对象，键名不变", () => {
  const input = { a: [BARE], b: { c: BARE }, DeepSeek: "untouched-key" };
  const out = scrub(input);
  assert.deepEqual(out, { a: [BROKEN], b: { c: BROKEN }, DeepSeek: "untouched-key" });
});

test("reshape 超阈值时把尾部搬进 user 消息", () => {
  const body = "x".repeat(200);
  const payload = {
    model: "m",
    messages: [{ role: "system", content: body }, { role: "user", content: "hi" }],
  };
  const { payload: out, split } = reshape(payload, { splitLimit: 50 });
  assert.equal(split, true);
  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[0].content.length, 50);
  assert.equal(out.messages[1].role, "user");
  assert.ok(out.messages[1].content.endsWith(body.slice(50)));
  assert.equal(out.messages[2].content, "hi");
});

test("reshape 未超阈值时原样返回", () => {
  const payload = { messages: [{ role: "system", content: "short" }] };
  const { payload: out, split } = reshape(payload, { splitLimit: 100 });
  assert.equal(split, false);
  assert.equal(out, payload);
});

test("reshape 首条不是 system 时不动", () => {
  const payload = { messages: [{ role: "user", content: "y".repeat(500) }] };
  assert.equal(reshape(payload, { splitLimit: 10 }).split, false);
});

test("processBody 在非 JSON 上原样透传", () => {
  const r = processBody("not json at all");
  assert.equal(r.changed, false);
  assert.equal(r.body, "not json at all");
  assert.equal(r.stats, null);
});

test("processBody 两条规则同时生效", () => {
  const long = (BARE + SP).repeat(2000);
  const raw = JSON.stringify({
    model: "m",
    messages: [{ role: "system", content: long }, { role: "user", content: "hi" }],
  });
  const r = processBody(raw, { splitLimit: 1000 });
  assert.equal(r.scrubbed, true);
  assert.equal(r.split, true);
  const parsed = JSON.parse(r.body);
  assert.equal(parsed.messages[0].content.length, 1000);
  assert.equal(parsed.messages[0].content.includes(BARE), false);
  assert.equal(parsed.messages[1].content.includes(BARE), false);
  assert.ok(parsed.messages[1].content.includes(BROKEN));
});

test("processBody keywordBreak=false 时只搬运不断词", () => {
  const long = (BARE + SP).repeat(500);
  const raw = JSON.stringify({ messages: [{ role: "system", content: long }] });
  const r = processBody(raw, { splitLimit: 100, keywordBreak: false });
  assert.equal(r.scrubbed, false);
  assert.equal(r.split, true);
  assert.ok(r.body.includes(BARE));
});

test("processBody 记载体量变化", () => {
  const raw = JSON.stringify({
    model: "m",
    tools: [{ type: "function" }, { type: "function" }],
    messages: [{ role: "system", content: "s".repeat(5000) }, { role: "user", content: "hi" }],
  });
  const r = processBody(raw, { splitLimit: 1000 });
  assert.equal(r.stats.originalSystemLength, 5000);
  assert.equal(r.stats.systemLength, 1000);
  assert.equal(r.stats.nTools, 2);
  assert.equal(r.stats.nMessages, 3);
  assert.equal(r.stats.model, "m");
});

test("looksLikeChannelFingerprint 只认首条身份句", () => {
  assert.equal(looksLikeChannelFingerprint(`You are an AI agent powered by ${BROKEN}.`), true);
  assert.equal(looksLikeChannelFingerprint("YOU ARE AN AI AGENT POWERED BY DEEPSEEK"), true);
  assert.equal(looksLikeChannelFingerprint("You are helpful."), false);
  assert.equal(looksLikeChannelFingerprint(undefined), false);
});

test("shouldSanitize 支持三种写法与大小写", () => {
  const hosts = ["10.0.0.10:8080", "api.example.com", "gw.local/v1"];
  assert.equal(shouldSanitize("http://10.0.0.10:8080/v1/chat/completions", hosts), true);
  assert.equal(shouldSanitize("https://API.EXAMPLE.COM/x", hosts), true);
  assert.equal(shouldSanitize("http://gw.local/v1/chat/completions", hosts), true);
  assert.equal(shouldSanitize("https://api.deepseek.com/v1/chat/completions", hosts), false);
  assert.equal(shouldSanitize("not a url", hosts), false);
  assert.equal(shouldSanitize("http://x/y", []), false);
});

test("textOf 兼容字符串与分块数组", () => {
  assert.equal(textOf("abc"), "abc");
  assert.equal(textOf([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(textOf(null), "");
});
