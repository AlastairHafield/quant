import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignalEmbed, postDiscordEmbed, flushLogBufferToDiscord } from "../src/discord.js";

test("buildSignalEmbed: shapes an embed with inline fields and a footer", () => {
  const embed = buildSignalEmbed({
    title: "LONG — Strategy A",
    description: "Entry 5527",
    color: 0x2ecc71,
    fields: [["Regime", "NEG_GAMMA"], ["Flow grade", "A"]],
    footerText: "MES · signal-only",
  });
  assert.equal(embed.embeds[0].title, "LONG — Strategy A");
  assert.equal(embed.embeds[0].fields.length, 2);
  assert.deepEqual(embed.embeds[0].fields[0], { name: "Regime", value: "NEG_GAMMA", inline: true });
  assert.equal(embed.embeds[0].footer.text, "MES · signal-only");
});

test("postDiscordEmbed: skips the network call entirely when no webhook is configured", async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return { ok: true };
  };
  const result = await postDiscordEmbed(null, { embeds: [] }, fakeFetch);
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});

test("postDiscordEmbed: posts JSON to the webhook and reports ok on success", async () => {
  let capturedUrl, capturedInit;
  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return { ok: true };
  };
  const result = await postDiscordEmbed("https://discord.test/webhook", { embeds: [{ title: "x" }] }, fakeFetch);
  assert.equal(result.ok, true);
  assert.equal(capturedUrl, "https://discord.test/webhook");
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(capturedInit.body), { embeds: [{ title: "x" }] });
});

test("postDiscordEmbed: reports failure with status when the webhook rejects the request", async () => {
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => "rate limited" });
  const result = await postDiscordEmbed("https://discord.test/webhook", { embeds: [] }, fakeFetch);
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
});

test("flushLogBufferToDiscord: skips when there are no rows or no webhook configured", async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return { ok: true };
  };
  assert.deepEqual(await flushLogBufferToDiscord("https://discord.test/webhook", [], "2026-07-24", "session_end", fakeFetch), {
    skipped: true,
  });
  assert.deepEqual(await flushLogBufferToDiscord(null, [{ ts: "t" }], "2026-07-24", "session_end", fakeFetch), {
    skipped: true,
  });
  assert.equal(called, false);
});

test("flushLogBufferToDiscord: posts a multipart form with the JSONL attachment on success", async () => {
  let capturedInit;
  const fakeFetch = async (url, init) => {
    capturedInit = init;
    return { ok: true };
  };
  const rows = [{ ts: "t1" }, { ts: "t2" }];
  const result = await flushLogBufferToDiscord("https://discord.test/webhook", rows, "2026-07-24", "session_end", fakeFetch);
  assert.equal(result.ok, true);
  assert.ok(capturedInit.body instanceof FormData);
});

test("flushLogBufferToDiscord: reports failure when the webhook post throws", async () => {
  const fakeFetch = async () => {
    throw new Error("network down");
  };
  const result = await flushLogBufferToDiscord("https://discord.test/webhook", [{ ts: "t" }], "2026-07-24", "session_end", fakeFetch);
  assert.equal(result.ok, false);
  assert.equal(result.error, "network down");
});
