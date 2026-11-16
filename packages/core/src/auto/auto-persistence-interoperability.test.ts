import { expect, it } from "vitest";

import {
  createParityHarness,
  deferred,
  storageEntries,
  waitUntil,
  type ParityHarness,
  type ProductKind,
} from "./auto-product-test-fixtures.test-helper.js";

function opposite(kind: ProductKind): ProductKind {
  return kind === "auto" ? "generic" : "auto";
}

async function writtenEntries(
  kind: ProductKind,
  decide: (harness: ParityHarness) => Promise<unknown>,
): Promise<readonly (readonly [string, string])[]> {
  const harness = createParityHarness(kind);
  await harness.client.initialize();
  await decide(harness);
  return [...harness.storage.values.entries()].map(
    (entry) => [entry[0], entry[1]] as const,
  );
}

const decisions: readonly {
  readonly decide: (harness: ParityHarness) => Promise<unknown>;
  readonly name: string;
}[] = [
  {
    decide: (harness) => harness.client.acceptAll(),
    name: "an accepted grant",
  },
  {
    decide: (harness) => harness.client.rejectAll(),
    name: "a complete denial",
  },
  {
    decide: async (harness) => {
      await harness.client.acceptAll();
      await harness.client.withdrawConsent();
    },
    name: "a withdrawal",
  },
];

it.each(decisions)(
  "produces byte-identical local-storage state for $name",
  async ({ decide }) => {
    const generic = await writtenEntries("generic", decide);
    const auto = await writtenEntries("auto", decide);
    expect(Object.fromEntries(auto)).toEqual(Object.fromEntries(generic));
    expect(auto.length).toBeGreaterThan(0);
  },
);

it("produces byte-identical cookie writes for equivalent commands", async () => {
  const generic = createParityHarness("generic", { persistence: "cookie" });
  const auto = createParityHarness("auto", { persistence: "cookie" });
  for (const harness of [generic, auto]) {
    await harness.client.initialize();
    await harness.client.acceptAll();
    await harness.client.withdrawConsent();
  }

  expect(auto.cookieJar.writes).toEqual(generic.cookieJar.writes);
  expect(auto.cookieJar.writes.length).toBeGreaterThan(0);
  expect(Object.fromEntries(auto.cookieJar.values)).toEqual(
    Object.fromEntries(generic.cookieJar.values),
  );
});

it.each([{ kind: "auto" as const }, { kind: "generic" as const }])(
  "restores the other product's active grant envelope on $kind",
  async ({ kind }) => {
    const written = await writtenEntries(opposite(kind), (harness) =>
      harness.client.acceptAll(),
    );
    const restoring = createParityHarness(kind, { initialEntries: written });
    const mirror = createParityHarness(opposite(kind), {
      initialEntries: written,
    });

    const restored = await restoring.client.initialize();
    const mirrored = await mirror.client.initialize();

    expect(restored.readiness).toBe("ready");
    expect(restored.grantActivation).toBe("active");
    expect(restoring.client.getSnapshot()).toEqual(mirror.client.getSnapshot());
    expect(storageEntries(restoring)).toEqual(storageEntries(mirror));
    expect(restored.record).toEqual(mirrored.record);
  },
);

it.each([{ kind: "auto" as const }, { kind: "generic" as const }])(
  "restores the other product's withdrawn envelope on $kind",
  async ({ kind }) => {
    const written = await writtenEntries(opposite(kind), async (harness) => {
      await harness.client.acceptAll();
      await harness.client.withdrawConsent();
    });
    const restoring = createParityHarness(kind, { initialEntries: written });

    const restored = await restoring.client.initialize();

    expect(restored.readiness).toBe("ready");
    expect(restored.grantActivation).toBe("not-applicable");
    expect(restored.record).toMatchObject({ method: "withdrawal" });
    expect(storageEntries(restoring)).toEqual(Object.fromEntries(written));
  },
);

it.each([{ kind: "auto" as const }, { kind: "generic" as const }])(
  "resumes the other product's staged pending envelope on $kind",
  async ({ kind }) => {
    const writer = createParityHarness(opposite(kind));
    await writer.client.initialize();
    const gate = deferred();
    writer.control.broadcastGate = gate.promise;
    const pending = writer.client.acceptAll();
    await waitUntil(() =>
      writer.calls.some((call) => call.port === "broadcast"),
    );
    const staged = [...writer.storage.values.entries()].map(
      (entry) => [entry[0], entry[1]] as const,
    );

    const restoring = createParityHarness(kind, { initialEntries: staged });
    const resumed = await restoring.client.initialize();

    writer.control.broadcastGate = undefined;
    gate.resolve();
    await pending;

    expect(resumed.readiness).toBe("ready");
    expect(resumed.grantActivation).toBe("active");
    expect(resumed.record).toMatchObject({ method: "accept-all" });
    expect(
      restoring.calls
        .filter((call) => call.port !== "receipt")
        .map((call) => call.port),
    ).toEqual(["broadcast", "reconcile"]);
  },
);
