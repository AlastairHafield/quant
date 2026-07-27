import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSignalEmbed,
  buildTradeTakenEmbed,
  buildDailySummaryEmbed,
  postDiscordEmbed,
  flushLogBufferToDiscord,
} from "../src/discord.js";

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

test("buildTradeTakenEmbed: long trade shapes a green embed with entry/stop/target and reasoning fields", () => {
  const embed = buildTradeTakenEmbed({
    system: "GEX Breakout",
    strategy: "A",
    direction: "long",
    size: 4,
    entryPrice: 7462,
    stopPrice: 7459,
    targetPrice: 7480,
    reasonFields: [["Regime", "NEG_GAMMA"], ["Flow grade", "A"]],
    orderId: 9056,
  });
  const e = embed.embeds[0];
  assert.match(e.title, /LONG/);
  assert.match(e.title, /GEX Breakout/);
  assert.match(e.title, /Strategy A/);
  assert.match(e.description, /7462/);
  assert.match(e.description, /7459/);
  assert.match(e.description, /7480/);
  assert.equal(e.color, 0x2ecc71);
  assert.ok(e.fields.some((f) => f.name === "Regime" && f.value === "NEG_GAMMA"));
  assert.ok(e.fields.some((f) => f.name === "Order ID" && f.value === "9056"));
});

test("buildTradeTakenEmbed: short trade is red and omits the strategy suffix when not given", () => {
  const embed = buildTradeTakenEmbed({
    system: "Mechanical ORB",
    strategy: null,
    direction: "short",
    size: 1,
    entryPrice: 7460,
    stopPrice: 7466,
    targetPrice: 7440,
    reasonFields: [["ADX", "31.4"]],
    orderId: null,
  });
  const e = embed.embeds[0];
  assert.match(e.title, /SHORT/);
  assert.match(e.title, /Mechanical ORB/);
  assert.doesNotMatch(e.title, /Strategy/);
  assert.equal(e.color, 0xe74c3c);
  assert.ok(e.fields.some((f) => f.name === "Order ID" && f.value === "—"));
});

test("buildDailySummaryEmbed: green when net positive, shows win rate/avg R/breakdowns", () => {
  const summary = {
    trades: {
      totalTrades: 3, wins: 2, losses: 1, winRate: 2 / 3, totalRealizedPnl: 125, avgRMultiple: 0.8,
      byStrategy: { A: { count: 2, pnl: 150 }, B: { count: 1, pnl: -25 } },
    },
    vetoes: { flow_grade_F: 5, wall_too_close: 2 },
    dynamicExits: { totalValueImpact: 60, byAction: { EXIT_NOW: { count: 1, valueImpact: 60 } } },
  };
  const embed = buildDailySummaryEmbed(summary, "2026-07-24");
  const e = embed.embeds[0];
  assert.equal(e.color, 0x2ecc71);
  assert.match(e.description, /3 trades/);
  assert.match(e.description, /2W\/1L/);
  assert.match(e.description, /\+\$125\.00/);
  assert.ok(e.fields.some((f) => f.name === "Win rate" && f.value === "67%"));
  assert.ok(e.fields.some((f) => f.name === "Avg R" && f.value === "0.80"));
  assert.ok(e.fields.some((f) => f.name === "By strategy" && f.value.includes("A: 2 trades")));
  assert.ok(e.fields.some((f) => f.name === "Top veto reasons" && f.value.includes("flow_grade_F: 5")));
});

test("buildDailySummaryEmbed: red when net negative, handles an all-empty day gracefully", () => {
  const summary = {
    trades: { totalTrades: 0, wins: 0, losses: 0, winRate: null, totalRealizedPnl: -10, avgRMultiple: null, byStrategy: {} },
    vetoes: {},
    dynamicExits: { totalValueImpact: 0, byAction: {} },
  };
  const embed = buildDailySummaryEmbed(summary, "2026-07-24");
  const e = embed.embeds[0];
  assert.equal(e.color, 0xe74c3c);
  assert.ok(e.fields.some((f) => f.name === "Win rate" && f.value === "—"));
  assert.ok(e.fields.some((f) => f.name === "By strategy" && f.value === "—"));
});

test("buildDailySummaryEmbed: shows a manual closes field only when at least one happened that day", () => {
  const withManual = {
    trades: {
      totalTrades: 3, wins: 2, losses: 1, winRate: 2 / 3, totalRealizedPnl: 125, avgRMultiple: 0.8,
      byStrategy: { A: { count: 2, pnl: 150 }, B: { count: 1, pnl: -25 } },
      manualCloses: { count: 1, wins: 0, losses: 1, pnl: -25 },
    },
    vetoes: {},
    dynamicExits: { totalValueImpact: 0, byAction: {} },
  };
  const e1 = buildDailySummaryEmbed(withManual, "2026-07-24").embeds[0];
  assert.ok(e1.fields.some((f) => f.name === "Manual closes" && f.value.includes("1x (0W/1L)") && f.value.includes("$-25.00")));

  const withoutManual = {
    trades: {
      totalTrades: 1, wins: 1, losses: 0, winRate: 1, totalRealizedPnl: 50, avgRMultiple: 1,
      byStrategy: { A: { count: 1, pnl: 50 } }, manualCloses: { count: 0, wins: 0, losses: 0, pnl: 0 },
    },
    vetoes: {},
    dynamicExits: { totalValueImpact: 0, byAction: {} },
  };
  const e2 = buildDailySummaryEmbed(withoutManual, "2026-07-24").embeds[0];
  assert.ok(!e2.fields.some((f) => f.name === "Manual closes"));
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
