import FMPClient from '../api/fmp.js';
import { upsertStock, getUniverse } from '../data/db.js';

const MIN_MARKET_CAP = 10e9;
const MIN_AVG_VOLUME = 1_000_000;
const TARGET_UNIVERSE_SIZE = 50;

const ALLOWED_SECTORS = [
  'Technology',
  'Consumer Cyclical',
  'Consumer Defensive',
  'Healthcare',
  'Financial Services',
  'Industrials',
  'Communication Services',
  'Energy',
  'Basic Materials',
  'Real Estate',
  'Utilities',
];

export async function buildUniverse(apiKey) {
  const fmp = new FMPClient(apiKey);

  console.log('Fetching stock universe via screener...');
  const stocks = await fmp.getStockScreener({
    minMarketCap: MIN_MARKET_CAP,
    minVolume: MIN_AVG_VOLUME,
    limit: 250,
  });

  if (!stocks || !Array.isArray(stocks)) {
    throw new Error('Screener returned no data');
  }

  console.log(`Screener returned ${stocks.length} candidates. Filtering...`);

  const qualified = stocks.filter(s =>
    s.country === 'US' &&
    !s.isEtf &&
    !s.isFund &&
    s.marketCap >= MIN_MARKET_CAP &&
    s.volume >= MIN_AVG_VOLUME &&
    ALLOWED_SECTORS.includes(s.sector)
  );

  qualified.sort((a, b) => b.marketCap - a.marketCap);
  const universe = qualified.slice(0, TARGET_UNIVERSE_SIZE);

  console.log(`Saving ${universe.length} stocks to universe...`);
  universe.forEach(s => upsertStock({
    symbol: s.symbol,
    name: s.companyName,
    sector: s.sector,
    market_cap: s.marketCap,
    avg_volume: s.volume,
  }));

  return universe;
}

export function getCurrentUniverse() {
  return getUniverse();
}
