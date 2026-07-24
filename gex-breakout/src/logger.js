export function buildLogRow({
  ts,
  strategy,
  direction,
  level,
  regime,
  netGex,
  flipPoint,
  wallDistance,
  flowGrade,
  deltaStats,
  absorbed,
  vetoReason,
  entryPrice,
  stopPrice,
  targetPrice,
  outcome,
  mfe,
  mae,
}) {
  return {
    ts,
    strategy: strategy ?? null,
    direction: direction ?? null,
    level_type: level?.type ?? null,
    level_price: level?.price ?? null,
    regime: regime ?? null,
    net_gex: netGex ?? null,
    flip_point: flipPoint ?? null,
    wall_distance: wallDistance ?? null,
    flow_grade: flowGrade ?? null,
    delta_stats: deltaStats ?? null,
    absorbed: absorbed ?? false,
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
