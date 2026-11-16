export const CONSENT_RUNTIME_MODEL = Object.freeze({
  schemaVersion: 1,
  intents: Object.freeze([
    "initialize",
    "accept-all",
    "save-preferences",
    "reject-all",
    "withdraw-consent",
    "retry-pending-grant",
    "refresh",
    "open-preferences",
    "close-preferences",
  ]),
  lanes: Object.freeze([
    "state",
    "signal",
    "persistence",
    "reentrant",
    "detached",
  ]),
  decisionMethods: Object.freeze(["accept-all", "granular", "reject-all"]),
  blockReasonOrder: Object.freeze([
    "invalid-policy",
    "first-visit",
    "policy-change",
    "withdrawn",
    "expired",
    "denied",
    "purpose-dependency",
    "service-preference",
    "privacy-signal",
  ]),
  eventTypes: Object.freeze({
    changed: "ConsentChanged",
    denied: "ConsentDenied",
    granted: "ConsentGranted",
    recordCreated: "ConsentRecordCreated",
    withdrawn: "ConsentWithdrawn",
  }),
  terminalInterpreter: Object.freeze({
    owner: Object.freeze({
      layer: "execute-denial-transition",
      symbol: "executeDenialTransitionProgram",
    }),
    programs: Object.freeze({
      ordinary: Object.freeze([
        "commit-pending",
        "broadcast",
        "reconcile",
        "persist",
        "receipt",
        "notify-final",
      ]),
      superseding: Object.freeze([
        "persist",
        "settle-grants",
        "broadcast",
        "reconcile",
        "receipt",
        "publish",
      ]),
    }),
  }),
  transitionEffects: Object.freeze({
    grant: Object.freeze([
      "persist",
      "commit",
      "broadcast",
      "reconcile",
      "receipt",
      "notify",
    ]),
  }),
  domainActions: Object.freeze([
    "record-consent-decision",
    "diff-decisions",
    "create-consent-event-batch",
    "withdraw-consent",
    "resolve-effective-access",
  ]),
  applicationActions: Object.freeze([
    "persist-grant",
    "persist-denial",
    "project-conservative-failure",
    "execute-grant-transition",
    "execute-denial-transition",
    "project-consent-runtime",
    "project-runtime-transition",
    "execute-runtime-decision",
    "execute-runtime-withdrawal",
  ]),
  pendingGrantActions: Object.freeze([
    "create-activation-descriptor",
    "resume",
    "activate",
    "prepare",
    "stage",
    "refresh",
    "restage",
    "stage-restored",
  ]),
  coordinatorActions: Object.freeze([
    "initialize",
    "decide",
    "retry-pending-grant",
    "refresh-expiry",
    "withdraw",
    "execute-terminal-program",
    "complete-grant",
    "correct-grant",
    "publish-snapshot",
    "open-preferences",
    "close-preferences",
    "subscribe",
    "reserve-terminal-capability",
    "close-terminal-capability",
  ]),
  coordinatorProtocol: Object.freeze({
    grant: Object.freeze([
      "broadcast",
      "activate",
      "reconcile",
      "aftercare",
      "publish",
    ]),
    expiry: Object.freeze(["reconcile", "broadcast"]),
  }),
  generatedLayers: Object.freeze([
    Object.freeze({
      name: "record-consent-decision",
      output: "packages/core/src/domain/consent-decisioning/record-decision.ts",
      template:
        "packages/core/protocol/templates/domain/consent-decisioning/record-decision.ts.txt",
    }),
    Object.freeze({
      name: "diff-consent-decisions",
      output: "packages/core/src/domain/consent-decisioning/diff-decisions.ts",
      template:
        "packages/core/protocol/templates/domain/consent-decisioning/diff-decisions.ts.txt",
    }),
    Object.freeze({
      name: "create-consent-events",
      output: "packages/core/src/domain/consent-decisioning/consent-events.ts",
      template:
        "packages/core/protocol/templates/domain/consent-decisioning/consent-events.ts.txt",
    }),
    Object.freeze({
      name: "withdraw-consent",
      output:
        "packages/core/src/domain/consent-decisioning/withdraw-consent.ts",
      template:
        "packages/core/protocol/templates/domain/consent-decisioning/withdraw-consent.ts.txt",
    }),
    Object.freeze({
      name: "resolve-effective-access",
      output:
        "packages/core/src/domain/terminal-enforcement/resolve-effective-access.ts",
      template:
        "packages/core/protocol/templates/domain/terminal-enforcement/resolve-effective-access.ts.txt",
    }),
    Object.freeze({
      name: "persist-grant",
      output: "packages/core/src/application/persistence/persist-grant.ts",
      template:
        "packages/core/protocol/templates/application/persistence/persist-grant.ts.txt",
    }),
    Object.freeze({
      name: "persist-denial",
      output: "packages/core/src/application/persistence/persist-denial.ts",
      template:
        "packages/core/protocol/templates/application/persistence/persist-denial.ts.txt",
    }),
    Object.freeze({
      name: "project-conservative-failure",
      output:
        "packages/core/src/application/persistence/conservative-projection.ts",
      template:
        "packages/core/protocol/templates/application/persistence/conservative-projection.ts.txt",
    }),
    Object.freeze({
      name: "execute-grant-transition",
      output:
        "packages/core/src/application/transitions/execute-grant-transition.ts",
      template:
        "packages/core/protocol/templates/application/transitions/execute-grant-transition.ts.txt",
    }),
    Object.freeze({
      name: "execute-denial-transition",
      output:
        "packages/core/src/application/transitions/execute-denial-transition.ts",
      template:
        "packages/core/protocol/templates/application/transitions/execute-denial-transition.ts.txt",
    }),
    Object.freeze({
      name: "project-consent-runtime",
      output:
        "packages/core/src/application/runtime/project-consent-runtime-kernel.ts",
      template:
        "packages/core/protocol/templates/application/runtime/project-consent-runtime-kernel.ts.txt",
    }),
    Object.freeze({
      name: "project-runtime-transition",
      output:
        "packages/core/src/application/runtime/consent-runtime-transition-projection-kernel.ts",
      template:
        "packages/core/protocol/templates/application/runtime/consent-runtime-transition-projection-kernel.ts.txt",
    }),
    Object.freeze({
      name: "execute-runtime-decision",
      output:
        "packages/core/src/application/runtime/execute-consent-runtime-decision-kernel.ts",
      template:
        "packages/core/protocol/templates/application/runtime/execute-consent-runtime-decision-kernel.ts.txt",
    }),
    Object.freeze({
      name: "execute-runtime-withdrawal",
      output:
        "packages/core/src/application/runtime/execute-consent-runtime-withdrawal-kernel.ts",
      template:
        "packages/core/protocol/templates/application/runtime/execute-consent-runtime-withdrawal-kernel.ts.txt",
    }),
    Object.freeze({
      name: "open-cookie-coordinator",
      output:
        "packages/core/src/application/runtime/create-open-cookie-kernel.ts",
      template:
        "packages/core/protocol/templates/create-open-cookie-kernel.ts.txt",
    }),
  ]),
});
