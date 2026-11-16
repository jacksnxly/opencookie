// docs:consumer-path: tests/consent-state.ts
// docs:display:start
import { createOpenCookieStore } from "../opencookie.config.js";

export async function setDeterministicConsent() {
  const client = createOpenCookieStore();
  await client.initialize();
  await client.savePreferences(["analytics"]);
  return client.getSnapshot();
}
// docs:display:end

export async function run(): Promise<void> {
  const snapshot = await setDeterministicConsent();
  if (
    snapshot.record?.decisions.find(
      ({ purposeId }) => purposeId === "analytics",
    )?.value !== "granted"
  ) {
    throw new Error(
      "The deterministic consent sample did not grant analytics.",
    );
  }
}
