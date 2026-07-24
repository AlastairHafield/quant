let latestStatus = null;

export function setMechanicalOrbStatus(payload) {
  latestStatus = payload;
}

export function getMechanicalOrbStatus() {
  return latestStatus;
}
