import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignalEmbed, buildTradeTakenEmbed, postDiscordEmbed } from "../src/discord.js";

test("buildSignalEmbed: shapes an embed with inline fields and a footer", () => {
  const embed = buildSignalEmbed({
    title: "LONG",
    description: "Entry 5527",
    color: 0x2ecc71,
    fields: [["ADX", "31.4"]],
    footerText: "MES",
  });
  assert.equal(embed.embeds[0].title, "LONG");
  assert.deepEqual(embed.embeds[0].fields[0], { name: "ADX", value: "31.4", inline: true });
});

test("buildTradeTakenEmbed: no fixed target shows 'ride to EOD' instead of a price", () => {
  const embed = buildTradeTakenEmbed({
    system: "Mechanical ORB",
    strategy: null,
    direction: "long",
    size: 1,
    entryPrice: 7462,
    stopPrice: 7447,
    targetPrice: null,
    reasonFields: [["ADX", "31.4"], ["OR range", "10"]],
    orderId: 9101,
  });
  const e = embed.embeds[0];
  assert.match(e.description, /ride to EOD/);
  assert.equal(e.color, 0x2ecc71);
  assert.ok(e.fields.some((f) => f.name === "Order ID" && f.value === "9101"));
});

test("postDiscordEmbed: skips the network call when no webhook is configured", async () => {
  let called = false;
  const result = await postDiscordEmbed(null, { embeds: [] }, async () => { called = true; return { ok: true }; });
  assert.equal(result.skipped, true);
  assert.equal(called, false);
});
