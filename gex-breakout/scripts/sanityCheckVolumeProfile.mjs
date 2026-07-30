// Manual sanity check for volumeProfile.js — deliberately NOT part of
// `node --test`. Volume profile has no independent source of truth to unit
// test against (it's derived from real bar data, not a documented formula
// like the GEX engine's), so the actual check is eyeballing whether POC/VAH/
// VAL look like a real chart's value area, not asserting a specific number.
//
// Pulls real 1-min bars from TopstepX (the broker this bot already
// authenticates against for everything else) — not Databento, which is
// reserved for the backend's historical backtesting only — and prints
// POC/VAH/VAL per RTH session for the last N days.
//
// Usage: node --env-file=.env scripts/sanityCheckVolumeProfile.mjs [days] [symbol]

import { fetchHistoricalBars } from "../src/dataSources/topstepx.js";
import { buildSessionProfile, findPOC, computeValueArea, groupBarsByDay } from "../src/volumeProfile.js";
import { CONFIG } from "../src/config.js";

const days = Number(process.argv[2] ?? 10);
const symbol = process.argv[3] ?? CONFIG.instrumentData;
const vpConfig = CONFIG.orderFlowBot.volumeProfile;

const toDate = new Date().toISOString().slice(0, 10);
const fromDate = new Date(Date.now() - (days + 5) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // pad for weekends/holidays

const bars = await fetchHistoricalBars(symbol, { fromDate, toDate });

// RTH only (9:30-16:00 ET) — matches the session the live Order Flow Bot
// actually trades, not the near-24hr Globex session TopstepX also returns.
const rthBars = bars.filter((b) => b.ny_time >= 930 && b.ny_time <= 1600);
const byDay = groupBarsByDay(rthBars);
const dayKeys = [...byDay.keys()].sort().slice(-days);

console.log(`\n${symbol} — RTH session volume profile, last ${dayKeys.length} day(s)\n`);
for (const day of dayKeys) {
  const dayBars = byDay.get(day);
  const profile = buildSessionProfile(dayBars, vpConfig);
  const poc = findPOC(profile);
  const va = computeValueArea(profile, poc, vpConfig.valueAreaPct);
  const enough = dayBars.length >= vpConfig.minSessionBars ? "" : "  (thin session — below minSessionBars)";
  console.log(
    `${day}  POC=${poc?.toFixed(2)}  VAH=${va?.high?.toFixed(2)}  VAL=${va?.low?.toFixed(2)}  (${dayBars.length} bars)${enough}`
  );
}
