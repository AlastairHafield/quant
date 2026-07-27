export function buildLogRow({ ts, direction, adx, priorClose, gapPct, vetoReason, entryPrice, stopPrice, targetPrice, outcome, mfe, mae }) {
  return {
    ts,
    direction: direction ?? null,
    adx: adx ?? null,
    prior_close: priorClose ?? null,
    gap_pct: gapPct ?? null,
    veto_reason: vetoReason ?? null,
    entry_price: entryPrice ?? null,
    stop_price: stopPrice ?? null,
    target_price: targetPrice ?? null,
    outcome: outcome ?? null,
    mfe: mfe ?? null,
    mae: mae ?? null,
  };
}

export class SignalLogger {
  constructor() {
    this.buffer = [];
  }

  log(row) {
    console.log(JSON.stringify(row));
    this.buffer.push(row);
    return row;
  }

  drain() {
    const rows = this.buffer;
    this.buffer = [];
    return rows;
  }

  get size() {
    return this.buffer.length;
  }
}
