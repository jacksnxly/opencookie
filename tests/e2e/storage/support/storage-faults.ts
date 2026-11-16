export type StorageFault =
  | "local-storage-getter-security-error"
  | "cached-get-item-security-error"
  | "set-item-quota-exceeded-error"
  | "silent-cookie-write-suppression"
  | "context-ephemerality"
  | "deterministic-cross-site-cookie-denial-emulation";

export interface StorageFaultOptions {
  readonly fault: StorageFault;
  readonly route: "/__storage/cookie" | "/__storage/local";
}

export interface StorageFaultSnapshot {
  readonly active: boolean;
  readonly cookieHeader: string;
  readonly errorNames: readonly string[];
  readonly fault: StorageFault;
  readonly globalControlEnumerable: boolean;
  readonly localDecision: string | null;
  readonly operations: {
    readonly cookieReads: number;
    readonly cookieWrites: number;
    readonly localGetterReads: number;
    readonly localReads: number;
    readonly localRemoves: number;
    readonly localWrites: number;
  };
  readonly released: boolean;
}

export interface StorageFaultControl {
  readonly release: () => void;
  readonly snapshot: () => StorageFaultSnapshot;
}

export interface StorageFaultGlobal {
  readonly __ocStorageFaultControl: StorageFaultControl;
  readonly __ocAnalyticsLoads?: number;
}

/** Installs one deterministic browser fault before any fixture script runs. */
export function installStorageFault(options: StorageFaultOptions): void {
  function accessor(target: object, property: string): PropertyDescriptor {
    let candidate: object | null = target;
    while (candidate !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, property);
      if (descriptor !== undefined) return descriptor;
      candidate = Object.getPrototypeOf(candidate) as object | null;
    }
    throw new Error(`Native ${property} accessor is unavailable.`);
  }

  const localStorageAccessor = accessor(globalThis, "localStorage");
  const sessionStorageAccessor = accessor(globalThis, "sessionStorage");
  const cookieAccessor = accessor(document, "cookie");
  if (
    localStorageAccessor.get === undefined ||
    sessionStorageAccessor.get === undefined ||
    cookieAccessor.get === undefined ||
    cookieAccessor.set === undefined
  ) {
    throw new Error("Required native browser storage accessors are missing.");
  }

  const nativeLocalStorage = localStorageAccessor.get.bind(globalThis);
  const nativeSessionStorage = sessionStorageAccessor.get.bind(globalThis);
  const sessionStorage = nativeSessionStorage() as Storage;
  const sessionGetItem = Storage.prototype.getItem.bind(sessionStorage);
  const sessionSetItem = Storage.prototype.setItem.bind(sessionStorage);
  const nativeCookieRead = cookieAccessor.get.bind(document);
  const nativeCookieWrite = cookieAccessor.set.bind(document);
  const recoveryMarker = `__oc_storage_recovered:${options.fault}`;
  let released = sessionGetItem(recoveryMarker) === "released";
  const active =
    location.hostname.endsWith(".opencookie.test") &&
    location.pathname === options.route;
  const errorNames: string[] = [];
  const operations = {
    cookieReads: 0,
    cookieWrites: 0,
    localGetterReads: 0,
    localReads: 0,
    localRemoves: 0,
    localWrites: 0,
  };

  const securityError = (): DOMException => {
    const error = new DOMException(
      "Storage access is unavailable in this browser context.",
      "SecurityError",
    );
    errorNames.push(error.name);
    return error;
  };
  const quotaError = (): DOMException => {
    const error = new DOMException(
      "The browser storage quota was exceeded.",
      "QuotaExceededError",
    );
    errorNames.push(error.name);
    return error;
  };
  const faultActive = (...faults: readonly StorageFault[]): boolean =>
    active && !released && faults.includes(options.fault);

  if (
    active &&
    [
      "local-storage-getter-security-error",
      "cached-get-item-security-error",
      "set-item-quota-exceeded-error",
    ].includes(options.fault)
  ) {
    let controlledStorage: Storage | undefined;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      enumerable: localStorageAccessor.enumerable ?? true,
      get(): Storage {
        operations.localGetterReads += 1;
        if (faultActive("local-storage-getter-security-error")) {
          throw securityError();
        }
        const storage = nativeLocalStorage() as Storage;
        if (
          options.fault !== "cached-get-item-security-error" &&
          options.fault !== "set-item-quota-exceeded-error"
        ) {
          return storage;
        }
        if (controlledStorage !== undefined) return controlledStorage;
        const getItem = Storage.prototype.getItem.bind(storage);
        const setItem = Storage.prototype.setItem.bind(storage);
        const removeItem = Storage.prototype.removeItem.bind(storage);
        controlledStorage = new Proxy(storage, {
          get(target, property): unknown {
            if (property === "getItem") {
              return (key: string): string | null => {
                operations.localReads += 1;
                if (faultActive("cached-get-item-security-error")) {
                  throw securityError();
                }
                return getItem(key);
              };
            }
            if (property === "setItem") {
              return (key: string, value: string): void => {
                operations.localWrites += 1;
                if (faultActive("set-item-quota-exceeded-error")) {
                  throw quotaError();
                }
                setItem(key, value);
              };
            }
            if (property === "removeItem") {
              return (key: string): void => {
                operations.localRemoves += 1;
                removeItem(key);
              };
            }
            return Reflect.get(target, property, target) as unknown;
          },
        });
        return controlledStorage;
      },
    });
  }

  if (
    active &&
    (options.fault === "silent-cookie-write-suppression" ||
      options.fault === "deterministic-cross-site-cookie-denial-emulation")
  ) {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      enumerable: cookieAccessor.enumerable ?? true,
      get(): string {
        operations.cookieReads += 1;
        return nativeCookieRead() as string;
      },
      set(serializedCookie: string) {
        operations.cookieWrites += 1;
        if (
          faultActive(
            "silent-cookie-write-suppression",
            "deterministic-cross-site-cookie-denial-emulation",
          )
        ) {
          return;
        }
        nativeCookieWrite(serializedCookie);
      },
    });
  }

  const snapshot = (): StorageFaultSnapshot => {
    let localDecision: string | null;
    try {
      const storage = nativeLocalStorage() as Storage;
      localDecision = Storage.prototype.getItem.call(
        storage,
        "opencookie.consent",
      );
    } catch {
      localDecision = null;
    }
    let cookieHeader: string;
    try {
      cookieHeader = nativeCookieRead() as string;
    } catch {
      cookieHeader = "";
    }
    return {
      active,
      cookieHeader,
      errorNames: [...errorNames],
      fault: options.fault,
      globalControlEnumerable: Object.prototype.propertyIsEnumerable.call(
        globalThis,
        "__ocStorageFaultControl",
      ),
      localDecision,
      operations: { ...operations },
      released,
    };
  };
  const control: StorageFaultControl = Object.freeze({
    release(): void {
      sessionSetItem(recoveryMarker, "released");
      released = true;
    },
    snapshot,
  });
  Object.defineProperty(globalThis, "__ocStorageFaultControl", {
    configurable: true,
    enumerable: false,
    value: control,
    writable: false,
  });
}
