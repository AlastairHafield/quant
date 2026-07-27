export function buildSignalEmbed({ title, description, color, fields, footerText }) {
  return {
    embeds: [
      {
        title,
        description,
        color,
        fields: fields.map(([name, value]) => ({ name, value: String(value), inline: true })),
        footer: { text: footerText },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

// A trade actually placed (vs. buildSignalEmbed's signal-only notice) — includes
// the reasoning (regime, flow grade, trigger level, etc.) as extra fields so a
// glance at Discord explains why the order went out, not just what it was.
export function buildTradeTakenEmbed({ system, strategy, direction, size, entryPrice, stopPrice, targetPrice, reasonFields, orderId }) {
  const dirLabel = direction === "long" ? "LONG" : "SHORT";
  const color = direction === "long" ? 0x2ecc71 : 0xe74c3c;
  return buildSignalEmbed({
    title: `${direction === "long" ? "🟢" : "🔴"} ${dirLabel} ${size}x — ${system}${strategy ? ` · Strategy ${strategy}` : ""}`,
    description: `Entry **${entryPrice}** / Stop **${stopPrice}** / Target **${targetPrice}**`,
    color,
    fields: [...reasonFields, ["Order ID", orderId ?? "—"]],
    footerText: `${system} · live order · ${new Date().toISOString()}`,
  });
}

export async function postDiscordEmbed(webhookUrl, embedPayload, fetchImpl = fetch) {
  if (!webhookUrl) {
    console.log("[DISCORD-DISABLED]", JSON.stringify(embedPayload));
    return { skipped: true };
  }
  const res = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(embedPayload),
  });
  if (!res.ok) {
    console.error("Discord webhook failed:", res.status, await res.text());
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

// Human-readable end-of-day recap — posted alongside (before) the raw .jsonl
// file dump below, which stays for anyone who wants the full detail. Built
// from dailySummary.js's computeDailySummary output.
export function buildDailySummaryEmbed(summary, dayKey) {
  const { trades, vetoes, dynamicExits } = summary;
  const pnlSign = trades.totalRealizedPnl >= 0 ? "+" : "";
  const strategyLines = Object.entries(trades.byStrategy)
    .map(([s, v]) => `${s}: ${v.count} trades, ${v.pnl >= 0 ? "+" : ""}$${v.pnl.toFixed(2)}`)
    .join("\n") || "—";
  const vetoLines = Object.entries(vetoes)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}: ${count}`)
    .join("\n") || "—";
  const dynamicExitLines = Object.entries(dynamicExits.byAction)
    .map(([action, v]) => `${action}: ${v.count}x, $${v.valueImpact.toFixed(2)}`)
    .join("\n") || "—";

  const fields = [
    ["Win rate", trades.winRate != null ? `${(trades.winRate * 100).toFixed(0)}%` : "—"],
    ["Avg R", trades.avgRMultiple != null ? trades.avgRMultiple.toFixed(2) : "—"],
    ["By strategy", strategyLines],
    ["Dynamic exits ($ impact)", dynamicExitLines],
    ["Top veto reasons", vetoLines],
  ];
  if (trades.manualCloses?.count > 0) {
    const mc = trades.manualCloses;
    fields.push(["Manual closes", `${mc.count}x (${mc.wins}W/${mc.losses}L), ${mc.pnl >= 0 ? "+" : ""}$${mc.pnl.toFixed(2)}`]);
  }
  // Strategy A trades its own practice account — kept out of every figure
  // above (real money only) and shown here separately, clearly labeled, so
  // it's never mistaken for part of the real P&L.
  if (trades.practice?.count > 0) {
    const p = trades.practice;
    fields.push([
      "Practice (Strategy A, not real $)",
      `${p.count}x (${p.wins}W/${p.losses}L), ${p.pnl >= 0 ? "+" : ""}$${p.pnl.toFixed(2)}`,
    ]);
  }

  return buildSignalEmbed({
    title: `📊 Daily Summary — GEX Breakout · ${dayKey}`,
    description: `${trades.totalTrades} real trades, ${trades.wins}W/${trades.losses}L — ${pnlSign}$${trades.totalRealizedPnl.toFixed(2)}`,
    color: trades.totalRealizedPnl >= 0 ? 0x2ecc71 : 0xe74c3c,
    fields,
    footerText: `GEX Breakout · daily summary · ${new Date().toISOString()}`,
  });
}

export async function flushLogBufferToDiscord(webhookUrl, rows, day, reason, fetchImpl = fetch) {
  if (!rows.length || !webhookUrl) return { skipped: true };

  const filename = `gex-breakout-log-${day}.jsonl`;
  const content = rows.map((r) => JSON.stringify(r)).join("\n");
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ content: `Session log **${day}** — ${rows.length} events (${reason})` })
  );
  form.append("files[0]", new Blob([content], { type: "application/x-ndjson" }), filename);

  try {
    const res = await fetchImpl(webhookUrl, { method: "POST", body: form });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return { ok: true };
  } catch (e) {
    console.error("Log flush failed:", e.message);
    return { ok: false, error: e.message };
  }
}
