let latestStatus = null;

export function setGexBreakoutStatus(payload) {
  latestStatus = payload;
}

export function getGexBreakoutStatus() {
  return latestStatus;
}
