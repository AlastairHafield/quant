// Manual operator CLI for the global kill switch (shared/killSwitch.js) — the
// one control no bot or agent-authored change can flip back on by itself.
//
// Usage (needs MONGODB_URI set in the environment, same value as any bot's .env):
//   node shared/setKillSwitch.js on "reason for halting"
//   node shared/setKillSwitch.js off
//   node shared/setKillSwitch.js status
import { isKillSwitchActive, setGlobalKillSwitch } from "./killSwitch.js";

async function main() {
  const [, , action, ...reasonParts] = process.argv;
  if (!["on", "off", "status"].includes(action)) {
    console.error('Usage: node shared/setKillSwitch.js <on "reason"|off|status>');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error("MONGODB_URI not set in this shell — export it first (same value as any bot's .env).");
    process.exit(1);
  }

  if (action === "status") {
    console.log(`Kill switch is currently: ${(await isKillSwitchActive()) ? "ACTIVE (halted)" : "inactive"}`);
    process.exit(0);
  }

  const active = action === "on";
  await setGlobalKillSwitch(active, active ? reasonParts.join(" ") || null : null);
  console.log(`Kill switch set to: ${active ? "ACTIVE (all bots halted)" : "inactive"}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("setKillSwitch failed:", e.message);
  process.exit(1);
});
