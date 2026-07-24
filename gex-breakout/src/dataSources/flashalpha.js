const BASE_URL = "https://lab.flashalpha.com";

function requireApiKey() {
  const key = process.env.FLASHALPHA_KEY;
  if (!key) throw new Error("FLASHALPHA_KEY not set — see gex-breakout/.env.example");
  return key;
}

async function faGet(path) {
  const apiKey = requireApiKey();
  const res = await fetch(`${BASE_URL}${path}`, { headers: { "X-Api-Key": apiKey } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`FlashAlpha ${path} -> ${res.status}: ${body}`);
  }
  return res.json();
}

// Confirmed against a live Basic-tier key on 2026-07-24: symbol "SPX" and the
// `?expiration=YYYY-MM-DD` param are both correct. FlashAlpha has no raw chain/greeks
// endpoint — /v1/exposure/gex/{symbol}?expiration=... returns GEX already computed
// per strike (call_gex/put_gex/net_gex, plus call_oi/put_oi/call_volume/put_volume),
// so there's no gamma×OI math left for us to do; we just aggregate across expiries.
// 0DTE (`expiration` = today) and the no-expiration full-chain call both 403 on
// Basic tier ("requires Growth plan") — resolves once the plan is upgraded, no code
// change needed.

export async function fetchExpirations(symbol) {
  const data = await faGet(`/v1/options/${symbol}`);
  return data.expirations.map((e) => e.expiration);
}

export function daysToExpiry(expirationYmd, nowET) {
  const [y, m, d] = expirationYmd.split("-").map(Number);
  const expiryUtcMidnight = Date.UTC(y, m - 1, d);
  const nowUtcMidnight = Date.UTC(nowET.getFullYear(), nowET.getMonth(), nowET.getDate());
  return Math.round((expiryUtcMidnight - nowUtcMidnight) / 86_400_000);
}

// Confirmed live 2026-07-24: summing raw per-strike net_gex across expiries and
// scanning for a zero-crossing does NOT give a meaningful flip point. A 0DTE
// option's gamma at a strike isn't the same quantity as a 5-DTE option's gamma at
// that same strike — summing them conflates different theoretical values, and on a
// real (heavily one-sided) book the combined cumulative sum can stay negative
// across the entire visible strike range, so "the" crossing it finds is just
// wherever accumulated noise happens to net to zero, nowhere near spot. FlashAlpha's
// own per-expiry gamma_flip is presumably computed properly (real gamma-weighted
// spot sensitivity) and all cluster tightly near spot in practice. Combine those
// via a |net_gex|-weighted average instead — which also naturally satisfies the
// spec's "weighted toward 0DTE" requirement, since 0DTE's net_gex magnitude
// dominates the weighting.
export function weightedFlipPoint(expiryResponses) {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const resp of expiryResponses) {
    if (resp.gamma_flip == null || resp.net_gex == null) continue;
    const weight = Math.abs(resp.net_gex);
    weightedSum += resp.gamma_flip * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : null;
}

export function aggregateStrikesAcrossExpiries(expiryResponses) {
  const byStrike = new Map();
  for (const resp of expiryResponses) {
    for (const s of resp.strikes ?? []) {
      byStrike.set(s.strike, (byStrike.get(s.strike) || 0) + s.net_gex);
    }
  }
  return [...byStrike.entries()]
    .map(([strike, gex]) => ({ strike: Number(strike), gex }))
    .sort((a, b) => a.strike - b.strike);
}

export async function fetchGexProfile(symbol, maxDte, nowET = new Date()) {
  const expirations = await fetchExpirations(symbol);
  const qualifying = expirations.filter((e) => {
    const dte = daysToExpiry(e, nowET);
    return dte >= 0 && dte <= maxDte;
  });
  if (!qualifying.length) {
    throw new Error(`No ${symbol} expirations within ${maxDte} DTE`);
  }

  const settled = await Promise.allSettled(
    qualifying.map((expiration) => faGet(`/v1/exposure/gex/${symbol}?expiration=${expiration}`))
  );
  const responses = [];
  const failures = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") responses.push(r.value);
    else failures.push({ expiration: qualifying[i], error: r.reason.message });
  });
  if (!responses.length) {
    throw new Error(`All ${symbol} expiration fetches failed: ${JSON.stringify(failures)}`);
  }
  if (failures.length) {
    console.warn(`FlashAlpha: ${failures.length}/${qualifying.length} expiration fetch(es) failed:`, failures);
  }

  return {
    profile: aggregateStrikesAcrossExpiries(responses),
    flipPoint: weightedFlipPoint(responses),
    spot: responses[0].underlying_price,
    asOf: responses[0].as_of,
    failures,
  };
}

// /v1/expected-move/{symbol} is confirmed working on Basic tier and returns
// underlying_price directly — a cheaper/more reliable spot-price read than the
// GEX endpoint, which needs an expiration filter and can 403 on restricted dates.
export async function fetchUnderlyingPrice(symbol) {
  const data = await faGet(`/v1/expected-move/${symbol}`);
  return data.underlying_price;
}
