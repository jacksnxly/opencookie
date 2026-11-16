export function checkedSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be a finite safe integer.`);
  }
  return value;
}
