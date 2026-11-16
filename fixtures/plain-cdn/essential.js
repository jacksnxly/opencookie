globalThis.__ocEssentialLoads = (globalThis.__ocEssentialLoads ?? 0) + 1;
globalThis.__ocConsentModeCalls = [];
globalThis.gtag = (...call) => {
  globalThis.__ocConsentModeCalls.push(call);
};
