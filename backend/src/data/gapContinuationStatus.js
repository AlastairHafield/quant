let latestStatus = null;

export function setGapContinuationStatus(payload) {
  latestStatus = payload;
}

export function getGapContinuationStatus() {
  return latestStatus;
}
