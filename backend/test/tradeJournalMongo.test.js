import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDailyLedger } from '../src/data/tradeJournalMongo.js';

test('aggregateDailyLedger: excludes open trades and trades with no realizedPnl yet', () => {
  const trades = [
    { system: 'gex-breakout', status: 'closed', realizedPnl: 100, mfe: 5, mae: 2 },
    { system: 'gex-breakout', status: 'open', realizedPnl: null },
    { system: 'gex-breakout', status: 'closed', realizedPnl: null }, // closed but no realizedPnl recorded — shouldn't happen, but guard anyway
  ];
  const ledger = aggregateDailyLedger('Mon Jan 01 2026', trades);
  assert.equal(ledger.accountWide.trades, 1);
  assert.equal(ledger.byStrategy['gex-breakout'].trades, 1);
});

test('aggregateDailyLedger: buckets by system and computes win rate / total P&L per strategy and account-wide', () => {
  const trades = [
    { system: 'gex-breakout', status: 'closed', realizedPnl: 100, mfe: 5, mae: 2 },
    { system: 'gex-breakout', status: 'closed', realizedPnl: -50, mfe: 1, mae: 3 },
    { system: 'mechanical-orb', status: 'closed', realizedPnl: 200, mfe: 8 },
    { system: 'gap-continuation', status: 'closed', realizedPnl: -30, mae: 4 },
  ];
  const ledger = aggregateDailyLedger('Mon Jan 01 2026', trades);

  assert.deepEqual(ledger.byStrategy['gex-breakout'], {
    trades: 2, wins: 1, losses: 1, totalRealizedPnl: 50, winRate: 50, avgMfe: 3, avgMae: 2.5,
  });
  assert.deepEqual(ledger.byStrategy['mechanical-orb'], {
    trades: 1, wins: 1, losses: 0, totalRealizedPnl: 200, winRate: 100, avgMfe: 8, avgMae: null,
  });
  assert.deepEqual(ledger.byStrategy['gap-continuation'], {
    trades: 1, wins: 0, losses: 1, totalRealizedPnl: -30, winRate: 0, avgMfe: null, avgMae: 4,
  });
  assert.deepEqual(ledger.accountWide, {
    trades: 4, wins: 2, losses: 2, winRate: 50, totalRealizedPnl: 220,
  });
});

test('aggregateDailyLedger: falls back to _dbName when a doc predates the system field', () => {
  const trades = [{ status: 'closed', realizedPnl: 10, _dbName: 'gap_continuation' }];
  const ledger = aggregateDailyLedger('Mon Jan 01 2026', trades);
  assert.equal(ledger.byStrategy.gap_continuation.trades, 1);
});

test('aggregateDailyLedger: empty input produces a zeroed, not crashed, ledger', () => {
  const ledger = aggregateDailyLedger('Mon Jan 01 2026', []);
  assert.deepEqual(ledger.byStrategy, {});
  assert.deepEqual(ledger.accountWide, { trades: 0, wins: 0, losses: 0, winRate: 0, totalRealizedPnl: 0 });
});
