export function computeBasis(esPrice, spxPrice) {
  return esPrice - spxPrice;
}

export function toEsLevel(levelSpx, basis) {
  if (levelSpx == null) return null;
  return levelSpx + basis;
}

export function toEsLevels(levelsSpx, basis) {
  return levelsSpx.map((l) => ({ ...l, price: toEsLevel(l.price, basis) }));
}

export function isBasisStale(basisAsOf, now, maxStaleMin) {
  const ageMin = (now.getTime() - basisAsOf.getTime()) / 60000;
  return ageMin > maxStaleMin;
}
