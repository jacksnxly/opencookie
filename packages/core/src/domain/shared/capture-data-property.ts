export type DataPropertyDescriptor = Omit<
  PropertyDescriptor,
  "get" | "set" | "value"
> & {
  readonly value: unknown;
};

export function captureDataProperty(
  source: unknown,
  field: PropertyKey,
  rejectInherited = true,
): DataPropertyDescriptor | null | undefined {
  if (source === null || typeof source !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, field);
    if (descriptor === undefined) {
      return rejectInherited && Reflect.has(source, field) ? undefined : null;
    }
    return "value" in descriptor
      ? (descriptor as DataPropertyDescriptor)
      : undefined;
  } catch {
    // Invalid or revoked proxies produce an invalid capture.
  }
}

export interface DataCaptureBudget {
  remaining: number;
}

export function captureDataArray<Entry = unknown>(
  value: unknown,
  maximumLength?: number,
  captureEntry?: (entry: unknown, index: number) => Entry,
  onInvalid?: (index?: number) => void,
): Entry[] | undefined;
export function captureDataArray<Entry = unknown>(
  value: unknown,
  budget: DataCaptureBudget,
  captureEntry: (entry: unknown, index: number) => Entry,
  onInvalid: (index?: number) => void,
  passthroughNonArray?: false,
  allowSparse?: false,
): Entry[] | undefined;
export function captureDataArray(
  value: unknown,
  budget: DataCaptureBudget,
  captureEntry: (entry: unknown, index: number) => unknown,
  onInvalid: (index?: number) => void,
  passthroughNonArray: boolean,
  allowSparse: boolean,
): unknown;
export function captureDataArray<Entry = unknown>(
  value: unknown,
  maximumLength: number | DataCaptureBudget = 10_000,
  captureEntry?: (entry: unknown, index: number) => Entry,
  onInvalid?: (index?: number) => void,
  passthroughNonArray = false,
  allowSparse = false,
): unknown {
  try {
    if (!Array.isArray(value)) {
      if (passthroughNonArray) return value;
      onInvalid?.();
      return undefined;
    }
  } catch {
    onInvalid?.();
    return undefined;
  }
  const lengthDescriptor = captureDataProperty(value, "length");
  const length = lengthDescriptor?.value;
  const limit =
    typeof maximumLength === "number" ? maximumLength : maximumLength.remaining;
  if (
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    (length as number) > limit
  ) {
    onInvalid?.();
    return undefined;
  }
  if (typeof maximumLength !== "number") {
    maximumLength.remaining -= length as number;
  }
  let captured: Entry[];
  try {
    captured = allowSparse ? new Array<Entry>(length as number) : [];
  } catch {
    onInvalid?.();
    return undefined;
  }
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = captureDataProperty(value, index, !allowSparse);
    if (!descriptor) {
      if (descriptor === undefined) onInvalid?.(index);
      else if (!allowSparse) onInvalid?.(index);
      if (allowSparse) continue;
      return undefined;
    }
    const entry =
      captureEntry === undefined
        ? (descriptor.value as Entry)
        : captureEntry(descriptor.value, index);
    if (allowSparse) captured[index] = entry;
    else captured.push(entry);
  }
  return captured;
}
