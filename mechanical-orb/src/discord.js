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

export function buildTradeTakenEmbed({ system, strategy, direction, size, entryPrice, stopPrice, targetPrice, reasonFields, orderId }) {
  const dirLabel = direction === "long" ? "LONG" : "SHORT";
  const color = direction === "long" ? 0x2ecc71 : 0xe74c3c;
  return buildSignalEmbed({
    title: `${direction === "long" ? "🟢" : "🔴"} ${dirLabel} ${size}x — ${system}${strategy ? ` · Strategy ${strategy}` : ""}`,
    description: `Entry **${entryPrice}** / Stop **${stopPrice}** / Target **${targetPrice ?? "ride to EOD"}**`,
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
