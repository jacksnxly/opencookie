export const PLAYGROUND_STORAGE_KEY = "opencookie-docs-playground";

interface StoredPlaygroundDecision {
  readonly granted: readonly string[];
  readonly method: string;
}

function storedDecision(value: string): StoredPlaygroundDecision | undefined {
  try {
    const parsed = JSON.parse(value) as {
      granted?: unknown;
      method?: unknown;
    };
    if (
      Array.isArray(parsed.granted) &&
      parsed.granted.every((entry) => typeof entry === "string") &&
      typeof parsed.method === "string"
    ) {
      return { granted: parsed.granted, method: parsed.method };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function initializePlayground(
  root: Element,
  storage: Storage = globalThis.localStorage,
): void {
  const receipt = root.querySelector<HTMLOutputElement>("[data-receipt]");
  const purposes = Array.from(
    root.querySelectorAll<HTMLInputElement>("[data-purpose]"),
  );
  if (!receipt) return;
  const status = receipt.querySelector<HTMLElement>("[data-receipt-status]");
  const methodValue = receipt.querySelector<HTMLElement>(
    "[data-receipt-method]",
  );
  const analyticsValue = receipt.querySelector<HTMLElement>(
    "[data-receipt-analytics]",
  );
  const personalizationValue = receipt.querySelector<HTMLElement>(
    "[data-receipt-personalization]",
  );
  if (!status || !methodValue || !analyticsValue || !personalizationValue) {
    return;
  }
  const receiptStatus = status;
  const receiptMethod = methodValue;
  const receiptAnalytics = analyticsValue;
  const receiptPersonalization = personalizationValue;

  const render = (method: string, granted: readonly string[]): void => {
    const value = (id: string) => (granted.includes(id) ? "granted" : "denied");
    receiptStatus.textContent = "Decision recorded";
    receiptMethod.textContent = method;
    receiptAnalytics.textContent = value("analytics");
    receiptPersonalization.textContent = value("personalization");
  };

  const decide = (method: string): void => {
    const granted =
      method === "accept-all"
        ? purposes.map(({ value }) => value)
        : method === "reject-all"
          ? []
          : purposes.filter(({ checked }) => checked).map(({ value }) => value);
    for (const purpose of purposes) {
      purpose.checked = granted.includes(purpose.value);
    }
    storage.setItem(
      PLAYGROUND_STORAGE_KEY,
      JSON.stringify({ granted, method }),
    );
    render(method, granted);
  };

  function reset(): void {
    storage.removeItem(PLAYGROUND_STORAGE_KEY);
    for (const purpose of purposes) purpose.checked = false;
    receiptStatus.textContent = "No decision yet";
    receiptMethod.textContent = "first-visit";
    receiptAnalytics.textContent = "unresolved";
    receiptPersonalization.textContent = "unresolved";
  }

  root
    .querySelector<HTMLButtonElement>('[data-decision="reject"]')
    ?.addEventListener("click", () => decide("reject-all"));
  root
    .querySelector<HTMLButtonElement>('[data-decision="accept"]')
    ?.addEventListener("click", () => decide("accept-all"));
  root
    .querySelector<HTMLButtonElement>('[data-decision="granular"]')
    ?.addEventListener("click", () => decide("granular"));
  root
    .querySelector<HTMLButtonElement>("[data-reset]")
    ?.addEventListener("click", reset);

  const saved = storage.getItem(PLAYGROUND_STORAGE_KEY);
  if (!saved) return;
  const parsed = storedDecision(saved);
  if (!parsed) {
    storage.removeItem(PLAYGROUND_STORAGE_KEY);
    return;
  }
  for (const purpose of purposes) {
    purpose.checked = parsed.granted.includes(purpose.value);
  }
  render(parsed.method, parsed.granted);
}

export function initializePlaygrounds(
  parent: ParentNode = document,
  storage: Storage = globalThis.localStorage,
): void {
  for (const root of parent.querySelectorAll<HTMLElement>(
    "[data-consent-playground]",
  )) {
    initializePlayground(root, storage);
  }
}
