export function classifyRegime({ netGex, price, flipPointEs, nearFlipPts }) {
  const baseRegime = netGex < 0 ? "NEG_GAMMA" : "POS_GAMMA";
  const nearFlip =
    flipPointEs != null && Math.abs(price - flipPointEs) < nearFlipPts;
  return {
    baseRegime,
    nearFlip,
    regime: nearFlip ? "NEAR_FLIP" : baseRegime,
  };
}

export function isFlipBreak(prevPrice, price, flipPointEs) {
  if (flipPointEs == null) return false;
  const wasBelow = prevPrice < flipPointEs;
  const isAbove = price >= flipPointEs;
  const wasAbove = prevPrice >= flipPointEs;
  const isBelow = price < flipPointEs;
  return (wasBelow && isAbove) || (wasAbove && isBelow);
}
