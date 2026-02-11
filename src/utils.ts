export function hasKey(obj: object) {
  for (const _ in obj) {
    return true;
  }
  return false;
}
