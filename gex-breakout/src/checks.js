export function timeCheck(nowET, cutoffET) {
  const minutes = nowET.getHours() * 60 + nowET.getMinutes();
  return minutes < cutoffET.h * 60 + cutoffET.m;
}
