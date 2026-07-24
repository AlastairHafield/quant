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
