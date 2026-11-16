import { describe, expect, it, vi } from "vitest";

import {
  createAccessEnforcementReconciler,
  type AccessEnforcementController,
} from "../../infrastructure.js";

function controller(
  initial: "active" | "blocked" | "dormant" = "dormant",
): AccessEnforcementController & {
  readonly block: ReturnType<typeof vi.fn>;
  readonly cleanup: ReturnType<typeof vi.fn>;
  readonly discover: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  return {
    block: vi.fn().mockImplementation(() => {
      current = "blocked";
      return Promise.resolve({ irreversibleEffects: [] });
    }),
    cleanup: vi.fn().mockResolvedValue({ irreversibleEffects: [] }),
    discover: vi.fn().mockImplementation(() => Promise.resolve(current)),
    start: vi.fn().mockImplementation(() => {
      current = "active";
      return Promise.resolve({ irreversibleEffects: [] });
    }),
    stop: vi.fn().mockImplementation(() => {
      current = "dormant";
      return Promise.resolve();
    }),
  };
}

describe("access enforcement reconciler", () => {
  it("TEST-SCRIPT-BLOCKING starts an allowed resource once and skips an unchanged plan", async () => {
    const analytics = controller();
    const reconciler = createAccessEnforcementReconciler({
      resources: { analytics },
    });

    await expect(
      reconciler.reconcile([{ access: "allowed", resourceId: "analytics" }]),
    ).resolves.toEqual({
      actions: [{ action: "started", resourceId: "analytics" }],
      failures: [],
      irreversibleEffects: [],
      status: "applied",
    });
    await expect(
      reconciler.reconcile([{ access: "allowed", resourceId: "analytics" }]),
    ).resolves.toEqual({
      actions: [],
      failures: [],
      irreversibleEffects: [],
      status: "unchanged",
    });
    expect(analytics.discover).toHaveBeenCalledTimes(2);
    expect(analytics.start).toHaveBeenCalledTimes(1);
  });

  it("TEST-SPA-DYNAMIC-DISCOVERY rechecks resources when desired access is unchanged", async () => {
    const allowedResource = controller();
    const allowedReconciler = createAccessEnforcementReconciler({
      resources: { analytics: allowedResource },
    });
    await allowedReconciler.reconcile([
      { access: "allowed", resourceId: "analytics" },
    ]);
    allowedResource.discover.mockResolvedValueOnce("blocked");

    await expect(
      allowedReconciler.reconcile([
        { access: "allowed", resourceId: "analytics" },
      ]),
    ).resolves.toMatchObject({
      actions: [{ action: "started", resourceId: "analytics" }],
      status: "applied",
    });
    expect(allowedResource.start).toHaveBeenCalledTimes(2);

    const blockedResource = controller("blocked");
    const blockedReconciler = createAccessEnforcementReconciler({
      resources: { marketing: blockedResource },
    });
    await blockedReconciler.reconcile([
      { access: "blocked", resourceId: "marketing" },
    ]);
    blockedResource.discover.mockResolvedValueOnce("active");

    await expect(
      blockedReconciler.reconcile([
        { access: "blocked", resourceId: "marketing" },
      ]),
    ).resolves.toMatchObject({
      actions: [
        { action: "stopped", resourceId: "marketing" },
        { action: "blocked", resourceId: "marketing" },
        { action: "cleaned", resourceId: "marketing" },
      ],
      status: "applied",
    });
    expect(blockedResource.discover).toHaveBeenCalledTimes(2);
  });

  it("TEST-WITHDRAW-REBLOCK stops, blocks, and cleans an active resource exactly once", async () => {
    const ads = controller();
    const reconciler = createAccessEnforcementReconciler({
      resources: { ads },
    });
    await reconciler.reconcile([{ access: "allowed", resourceId: "ads" }]);

    await expect(
      reconciler.reconcile([{ access: "blocked", resourceId: "ads" }]),
    ).resolves.toEqual({
      actions: [
        { action: "stopped", resourceId: "ads" },
        { action: "blocked", resourceId: "ads" },
        { action: "cleaned", resourceId: "ads" },
      ],
      failures: [],
      irreversibleEffects: [],
      status: "applied",
    });
    await reconciler.reconcile([{ access: "blocked", resourceId: "ads" }]);

    expect(ads.stop).toHaveBeenCalledTimes(1);
    expect(ads.block).toHaveBeenCalledTimes(1);
    expect(ads.cleanup).toHaveBeenCalledTimes(1);
  });

  it("fail closes omitted configured resources in deterministic order", async () => {
    const essential = controller("active");
    const zeta = controller("active");
    const aether = controller("active");
    const reconciler = createAccessEnforcementReconciler({
      resources: { essential, äther: aether, zeta },
    });
    await reconciler.reconcile([
      { access: "allowed", resourceId: "essential" },
      { access: "allowed", resourceId: "zeta" },
      { access: "allowed", resourceId: "äther" },
    ]);

    await expect(
      reconciler.reconcile([{ access: "allowed", resourceId: "essential" }]),
    ).resolves.toEqual({
      actions: [
        { action: "stopped", resourceId: "zeta" },
        { action: "blocked", resourceId: "zeta" },
        { action: "cleaned", resourceId: "zeta" },
        { action: "stopped", resourceId: "äther" },
        { action: "blocked", resourceId: "äther" },
        { action: "cleaned", resourceId: "äther" },
      ],
      failures: [],
      irreversibleEffects: [],
      status: "applied",
    });
    await reconciler.reconcile([
      { access: "allowed", resourceId: "essential" },
    ]);

    expect(essential.stop).not.toHaveBeenCalled();
    expect(zeta.stop).toHaveBeenCalledTimes(1);
    expect(aether.stop).toHaveBeenCalledTimes(1);
  });

  it("reports irreversible effects instead of claiming cleanup reversed them", async () => {
    const video = controller("active");
    video.block.mockResolvedValue({
      irreversibleEffects: ["iframe-network-request-already-sent"],
    });
    video.cleanup.mockResolvedValue({
      irreversibleEffects: ["third-party-server-state-unknown"],
    });
    const reconciler = createAccessEnforcementReconciler({
      resources: { video },
    });

    const result = await reconciler.reconcile([
      { access: "blocked", resourceId: "video" },
    ]);
    expect(result.irreversibleEffects).toEqual([
      {
        effect: "iframe-network-request-already-sent",
        resourceId: "video",
      },
      { effect: "third-party-server-state-unknown", resourceId: "video" },
    ]);
    expect(result.status).toBe("applied-with-irreversible-effects");
  });

  it("continues blocking and cleanup after stop fails, then retries only stop", async () => {
    const chat = controller("active");
    chat.stop.mockRejectedValueOnce(new Error("SDK cannot stop yet"));
    chat.block.mockResolvedValue({
      irreversibleEffects: ["future-loader-disabled"],
    });
    chat.cleanup.mockResolvedValue({
      irreversibleEffects: ["remote-session-unknown"],
    });
    const reconciler = createAccessEnforcementReconciler({
      resources: { chat },
    });

    await expect(
      reconciler.reconcile([{ access: "blocked", resourceId: "chat" }]),
    ).resolves.toEqual({
      actions: [
        { action: "blocked", resourceId: "chat" },
        { action: "cleaned", resourceId: "chat" },
      ],
      failures: [
        { operation: "stop", resourceId: "chat", type: "operation-failed" },
      ],
      irreversibleEffects: [
        { effect: "future-loader-disabled", resourceId: "chat" },
        { effect: "remote-session-unknown", resourceId: "chat" },
      ],
      status: "partial-failure",
    });
    await expect(
      reconciler.reconcile([{ access: "blocked", resourceId: "chat" }]),
    ).resolves.toEqual({
      actions: [{ action: "stopped", resourceId: "chat" }],
      failures: [],
      irreversibleEffects: [],
      status: "applied",
    });
    await expect(
      reconciler.reconcile([{ access: "blocked", resourceId: "chat" }]),
    ).resolves.toMatchObject({ status: "unchanged" });

    expect(chat.stop).toHaveBeenCalledTimes(2);
    expect(chat.block).toHaveBeenCalledTimes(1);
    expect(chat.cleanup).toHaveBeenCalledTimes(1);
  });

  it("continues fail-closed blocking when discovery fails", async () => {
    const analytics = controller();
    const reconciler = createAccessEnforcementReconciler({
      resources: { analytics },
    });
    await reconciler.reconcile([
      { access: "allowed", resourceId: "analytics" },
    ]);
    analytics.discover.mockRejectedValueOnce(
      new Error("DOM discovery unavailable"),
    );

    await expect(
      reconciler.reconcile([{ access: "blocked", resourceId: "analytics" }]),
    ).resolves.toEqual({
      actions: [
        { action: "stopped", resourceId: "analytics" },
        { action: "blocked", resourceId: "analytics" },
        { action: "cleaned", resourceId: "analytics" },
      ],
      failures: [
        {
          operation: "discover",
          resourceId: "analytics",
          type: "operation-failed",
        },
      ],
      irreversibleEffects: [],
      status: "partial-failure",
    });
    await expect(
      reconciler.reconcile([{ access: "blocked", resourceId: "analytics" }]),
    ).resolves.toMatchObject({ status: "unchanged" });

    expect(analytics.stop).toHaveBeenCalledTimes(1);
    expect(analytics.block).toHaveBeenCalledTimes(1);
    expect(analytics.cleanup).toHaveBeenCalledTimes(1);
  });

  it("treats failed initial discovery as potentially active while blocking", async () => {
    const marketing = controller("active");
    marketing.discover.mockRejectedValueOnce(
      new Error("Initial DOM discovery unavailable"),
    );
    const reconciler = createAccessEnforcementReconciler({
      resources: { marketing },
    });

    await expect(
      reconciler.reconcile([{ access: "blocked", resourceId: "marketing" }]),
    ).resolves.toMatchObject({
      actions: [
        { action: "stopped", resourceId: "marketing" },
        { action: "blocked", resourceId: "marketing" },
        { action: "cleaned", resourceId: "marketing" },
      ],
      failures: [
        {
          operation: "discover",
          resourceId: "marketing",
          type: "operation-failed",
        },
      ],
      status: "partial-failure",
    });
  });

  it("isolates failures and retries only the operation that did not complete", async () => {
    const chat = controller("active");
    chat.block.mockRejectedValueOnce(new Error("DOM unavailable"));
    const reconciler = createAccessEnforcementReconciler({
      resources: { chat },
    });

    const first = await reconciler.reconcile([
      { access: "blocked", resourceId: "chat" },
    ]);
    expect(first).toMatchObject({
      actions: [{ action: "stopped", resourceId: "chat" }],
      failures: [
        { operation: "block", resourceId: "chat", type: "operation-failed" },
      ],
      status: "partial-failure",
    });

    await expect(
      reconciler.reconcile([{ access: "blocked", resourceId: "chat" }]),
    ).resolves.toMatchObject({ status: "applied" });
    expect(chat.stop).toHaveBeenCalledTimes(1);
    expect(chat.block).toHaveBeenCalledTimes(2);
    expect(chat.cleanup).toHaveBeenCalledTimes(1);
  });
});
