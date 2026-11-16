import { readFile } from "node:fs/promises";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  executeConsentRuntimeDecision,
  executeConsentRuntimeWithdrawal,
  executeDenialTransition,
  toPersistedDecisionRecord,
} from "../src/application/index.js";
import {
  createOpenCookie,
  type ConsentReceipt,
  type ConsentRecord,
  type ConsentRuntimeTransitionEffect,
  type DecisionStore,
  type PersistedConsentState,
} from "../src/index.js";
import {
  recordConsentDecision,
  withdrawConsent,
} from "../src/domain/consent-decisioning/runtime.js";
import {
  createPolicySnapshot,
  definePolicy,
  defineResourcePolicy,
  type PolicySnapshot,
} from "../src/domain/policy-catalogue/index.js";
import { completeTestPolicyDefinition } from "../src/testing/policy-test-fixtures.test-helper.js";
import { persistedConsentStatesEqual } from "../src/application/runtime/persisted-consent-record.js";

import { CONSENT_RUNTIME_MODEL } from "./consent-runtime.model.mjs";

const coordinatorUrl = new URL(
  "../src/application/runtime/create-open-cookie-kernel.ts",
  import.meta.url,
);
const coordinatorTemplateUrl = new URL(
  "./templates/create-open-cookie-kernel.ts.txt",
  import.meta.url,
);
const decisionKernelUrl = new URL(
  "../src/application/runtime/execute-consent-runtime-decision-kernel.ts",
  import.meta.url,
);
const withdrawalKernelUrl = new URL(
  "../src/application/runtime/execute-consent-runtime-withdrawal-kernel.ts",
  import.meta.url,
);
const transitionUrl = new URL(
  "../src/application/transitions/execute-denial-transition.ts",
  import.meta.url,
);
const transitionTemplateUrl = new URL(
  "./templates/application/transitions/execute-denial-transition.ts.txt",
  import.meta.url,
);
const generatorUrl = new URL(
  "../../../scripts/phase4/generate-consent-runtime.mjs",
  import.meta.url,
);

const terminalOwner = "executeDenialTransitionProgram";
const expectedTerminalPrograms = Object.freeze({
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
});

function parsed(source: string, fileName = "module.ts"): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (candidate: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function importedSymbols(sourceFile: ts.SourceFile): readonly {
  readonly imported: string;
  readonly local: string;
  readonly module: string;
  readonly typeOnly: boolean;
}[] {
  const imports: {
    imported: string;
    local: string;
    module: string;
    typeOnly: boolean;
  }[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const element of statement.importClause.namedBindings.elements) {
      imports.push({
        imported: element.propertyName?.text ?? element.name.text,
        local: element.name.text,
        module: statement.moduleSpecifier.text,
        typeOnly: statement.importClause.isTypeOnly || element.isTypeOnly,
      });
    }
  }
  return imports;
}

function namedFunctions(
  sourceFile: ts.SourceFile,
): ReadonlyMap<string, ts.Node> {
  const functions = new Map<string, ts.Node>();
  walk(sourceFile, (candidate) => {
    if (ts.isFunctionDeclaration(candidate) && candidate.name) {
      functions.set(candidate.name.text, candidate);
      return;
    }
    if (
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.initializer &&
      (ts.isArrowFunction(candidate.initializer) ||
        ts.isFunctionExpression(candidate.initializer))
    ) {
      functions.set(candidate.name.text, candidate.initializer);
    }
  });
  return functions;
}

function calledIdentifiers(node: ts.Node): readonly string[] {
  const calls: string[] = [];
  walk(node, (candidate) => {
    if (
      ts.isCallExpression(candidate) &&
      ts.isIdentifier(candidate.expression)
    ) {
      calls.push(candidate.expression.text);
    }
  });
  return calls;
}

function reachesCall(
  sourceFile: ts.SourceFile,
  root: string,
  target: string,
): boolean {
  const functions = namedFunctions(sourceFile);
  const visited = new Set<string>();
  const visit = (name: string): boolean => {
    if (name === target) return true;
    if (visited.has(name)) return false;
    visited.add(name);
    const body = functions.get(name);
    if (!body) return false;
    return calledIdentifiers(body).some((called) => visit(called));
  };
  return visit(root);
}

function declarationCount(sourceFile: ts.SourceFile, name: string): number {
  let count = 0;
  walk(sourceFile, (candidate) => {
    if (ts.isFunctionDeclaration(candidate) && candidate.name?.text === name) {
      count += 1;
    }
  });
  return count;
}

function propertyCallCount(sourceFile: ts.SourceFile, name: string): number {
  let count = 0;
  walk(sourceFile, (candidate) => {
    if (
      ts.isCallExpression(candidate) &&
      ts.isPropertyAccessExpression(candidate.expression) &&
      candidate.expression.name.text === name
    ) {
      count += 1;
    }
  });
  return count;
}

function stringLiteralCount(
  sourceFile: ts.SourceFile,
  predicate: (value: string) => boolean,
): number {
  let count = 0;
  walk(sourceFile, (candidate) => {
    if (ts.isStringLiteral(candidate) && predicate(candidate.text)) count += 1;
  });
  return count;
}

function identifierCount(sourceFile: ts.SourceFile, name: string): number {
  let count = 0;
  walk(sourceFile, (candidate) => {
    if (ts.isIdentifier(candidate) && candidate.text === name) count += 1;
  });
  return count;
}

function propertyChain(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const left = propertyChain(node.expression);
  return left === undefined ? undefined : `${left}.${node.name.text}`;
}

function hasReplaceBinding(
  sourceFile: ts.SourceFile,
  token: string,
  modelPath: string,
): boolean {
  let found = false;
  walk(sourceFile, (candidate) => {
    if (
      !ts.isCallExpression(candidate) ||
      !ts.isPropertyAccessExpression(candidate.expression) ||
      candidate.expression.name.text !== "replaceAll" ||
      !ts.isStringLiteral(candidate.arguments[0]) ||
      candidate.arguments[0].text !== token
    ) {
      return;
    }
    const argument = candidate.arguments[1];
    if (!argument) return;
    walk(argument, (part) => {
      if (propertyChain(part) === modelPath) found = true;
    });
  });
  return found;
}

function variableInitializer(
  sourceFile: ts.SourceFile,
  name: string,
): ts.Expression | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

function syntaxValue(node: ts.Expression | undefined): unknown {
  if (node === undefined) return undefined;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return syntaxValue(node.expression);
  }
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.map((element) =>
      syntaxValue(element as ts.Expression),
    );
  }
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.flatMap((property) => {
        if (
          !ts.isPropertyAssignment(property) ||
          (!ts.isIdentifier(property.name) &&
            !ts.isStringLiteral(property.name))
        ) {
          return [];
        }
        return [[property.name.text, syntaxValue(property.initializer)]];
      }),
    );
  }
  return undefined;
}

function expectImportedOwner(
  sourceFile: ts.SourceFile,
  modulePath: string,
): string | undefined {
  const edges = importedSymbols(sourceFile).filter(
    (edge) => edge.imported === terminalOwner && edge.module === modulePath,
  );
  expect.soft(edges).toHaveLength(1);
  expect.soft(edges[0]?.typeOnly).toBe(false);
  return edges[0]?.local;
}

function runtimePolicy(purposeIds: readonly string[] = ["analytics"]) {
  const catalogue = definePolicy(
    completeTestPolicyDefinition({
      purposes: purposeIds.map((id) => ({ id })),
    }),
  );
  if (!catalogue.ok) throw new Error("Policy must be valid.");
  const policySnapshot = createPolicySnapshot({
    catalogueRevision: "catalogue-1",
    policy: catalogue.policy,
    policyVersion: "policy-1",
  });
  const resources = defineResourcePolicy({
    policy: catalogue.policy,
    resources: [
      {
        access: "optional",
        id: "analytics-script",
        purposeIds: ["analytics"],
        serviceId: "metrics",
      },
    ],
    services: [{ id: "metrics" }],
  });
  if (!resources.ok) throw new Error("Resource policy must be valid.");
  return { policySnapshot, resourcePolicy: resources.resourcePolicy };
}

function statesEqual(
  left: PersistedConsentState | null,
  right: PersistedConsentState | null,
): boolean {
  if (left === null || right === null) return left === right;
  return persistedConsentStatesEqual(left, right);
}

function observedStore(
  initial: PersistedConsentState | null,
  order: string[],
  onWrite: (candidate: PersistedConsentState) => void = () => undefined,
): {
  readonly read: () => PersistedConsentState | null;
  readonly store: DecisionStore;
} {
  let durable = initial;
  return {
    read: () => durable,
    store: {
      clear: () => {
        durable = null;
        return Promise.resolve();
      },
      clearIfCurrent: (expected) => {
        if (durable !== null && !statesEqual(durable, expected)) {
          return Promise.resolve("conflict" as const);
        }
        durable = null;
        return Promise.resolve("cleared" as const);
      },
      compareAndSet: (expected, candidate) => {
        const label = candidate.pendingGrant
          ? "pending-grant"
          : (candidate.record?.method ?? "empty");
        order.push(`persist:${label}`);
        if (!statesEqual(durable, expected)) {
          return Promise.resolve({ status: "conflict" as const });
        }
        durable = candidate;
        onWrite(candidate);
        return Promise.resolve({ status: "written" as const });
      },
      read: () =>
        Promise.resolve(
          durable === null
            ? { status: "missing" as const }
            : { state: durable, status: "stored" as const },
        ),
    },
  };
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function consentPolicy(policySnapshot: PolicySnapshot) {
  return {
    catalogueDigest: policySnapshot.catalogueDigest,
    decisionSurfaceDigest: policySnapshot.decisionSurfaceDigest,
    optionalPurposeIds: policySnapshot.policy.purposes.map(({ id }) => id),
    policyVersion: policySnapshot.policyVersion,
  };
}

function decidedRecord(
  policySnapshot: PolicySnapshot,
  method: "accept-all" | "reject-all",
): ConsentRecord {
  const result = recordConsentDecision(
    undefined,
    consentPolicy(policySnapshot),
    {
      decidedAt: 1_000,
      expiresAt: 86_401_000,
      method,
      recordId: "record-1",
    },
  );
  if (!result.ok || result.outcome !== "changed") {
    throw new Error("Decision fixture must be valid.");
  }
  return result.record;
}

function requiredRecord(record: ConsentRecord | undefined): ConsentRecord {
  if (record === undefined) throw new Error("Expected an active record.");
  return record;
}

type TerminalFault =
  | "candidate-clear-throws"
  | "confirmed"
  | "conflict"
  | "receipt-failure"
  | "reconcile-failure"
  | "signal-failure"
  | "throw-clear";

function differentialHarness(initial: PersistedConsentState | null): {
  readonly effects: {
    readonly broadcast: ConsentRuntimeTransitionEffect[];
    readonly commit: ConsentRuntimeTransitionEffect[];
    readonly notify: ConsentRuntimeTransitionEffect[];
    readonly reconcile: ConsentRuntimeTransitionEffect[];
  };
  readonly order: string[];
  readonly ports: ReturnType<typeof runtimePorts>;
  readonly read: () => PersistedConsentState | null;
  readonly setFault: (fault: TerminalFault) => void;
} {
  let durable = initial;
  let fault: TerminalFault = "confirmed";
  const order: string[] = [];
  const effects = {
    broadcast: [] as ConsentRuntimeTransitionEffect[],
    commit: [] as ConsentRuntimeTransitionEffect[],
    notify: [] as ConsentRuntimeTransitionEffect[],
    reconcile: [] as ConsentRuntimeTransitionEffect[],
  };
  const store: DecisionStore = {
    clear: () => {
      order.push("clear:any");
      durable = null;
      return Promise.resolve();
    },
    clearIfCurrent: (expected) => {
      const label = expected.pendingGrant
        ? "pending-grant"
        : (expected.record?.method ?? "empty");
      order.push(`clear:${label}`);
      if (fault === "candidate-clear-throws" && label === "withdrawal") {
        return Promise.reject(new Error("candidate cleanup unavailable"));
      }
      if (durable === null) return Promise.resolve("cleared" as const);
      if (!statesEqual(durable, expected)) {
        return Promise.resolve("conflict" as const);
      }
      durable = null;
      return Promise.resolve("cleared" as const);
    },
    compareAndSet: (expected, candidate) => {
      order.push(
        `persist:${candidate.pendingGrant ? "pending-grant" : (candidate.record?.method ?? "empty")}`,
      );
      if (fault === "throw-clear" || fault === "candidate-clear-throws") {
        return Promise.reject(new Error("storage unavailable"));
      }
      if (fault === "conflict") {
        return Promise.resolve({ status: "conflict" as const });
      }
      if (!statesEqual(durable, expected)) {
        return Promise.resolve({ status: "conflict" as const });
      }
      durable = candidate;
      return Promise.resolve({ status: "written" as const });
    },
    read: () =>
      Promise.resolve(
        durable === null
          ? { status: "missing" as const }
          : { state: durable, status: "stored" as const },
      ),
  };
  const ports = {
    broadcast: (effect: ConsentRuntimeTransitionEffect) => {
      effects.broadcast.push(effect);
      order.push(`broadcast:${effect.record.method}`);
      return fault === "signal-failure"
        ? Promise.reject(new Error("signal unavailable"))
        : Promise.resolve();
    },
    commit: (effect: ConsentRuntimeTransitionEffect) => {
      effects.commit.push(effect);
    },
    notify: (effect: ConsentRuntimeTransitionEffect) => {
      effects.notify.push(effect);
    },
    receipt: (receipt: ConsentReceipt) => {
      order.push(`receipt:${receipt.method}`);
      return fault === "receipt-failure"
        ? Promise.reject(new Error("receipt unavailable"))
        : Promise.resolve();
    },
    reconcile: (effect: ConsentRuntimeTransitionEffect) => {
      effects.reconcile.push(effect);
      order.push(`reconcile:${effect.record.method}`);
      return fault === "reconcile-failure"
        ? Promise.reject(new Error("reconcile unavailable"))
        : Promise.resolve();
    },
    store,
  };
  return {
    effects,
    order,
    ports,
    read: () => durable,
    setFault: (next) => {
      fault = next;
    },
  };
}

function runtimePorts(store: DecisionStore, order: string[]) {
  return {
    broadcast: (effect: { readonly record: { readonly method: string } }) => {
      order.push(`broadcast:${effect.record.method}`);
      return Promise.resolve();
    },
    commit: () => undefined,
    notify: () => undefined,
    receipt: (receipt: { readonly method: string }) => {
      order.push(`receipt:${receipt.method}`);
      return Promise.resolve();
    },
    reconcile: (effect: { readonly record: { readonly method: string } }) => {
      order.push(`reconcile:${effect.record.method}`);
      return Promise.resolve();
    },
    store,
  };
}

describe("generated terminal transition ownership", () => {
  it("routes every terminal entrypoint to one generated owner", async () => {
    const [
      coordinator,
      coordinatorTemplate,
      decisionKernel,
      withdrawalKernel,
      transition,
      transitionTemplate,
    ] = await Promise.all(
      [
        coordinatorUrl,
        coordinatorTemplateUrl,
        decisionKernelUrl,
        withdrawalKernelUrl,
        transitionUrl,
        transitionTemplateUrl,
      ].map((url) => readFile(url, "utf8")),
    );
    const coordinatorModule = parsed(
      coordinator,
      "create-open-cookie-kernel.ts",
    );
    const coordinatorTemplateModule = parsed(
      coordinatorTemplate,
      "create-open-cookie-kernel.template.ts",
    );
    const decisionModule = parsed(
      decisionKernel,
      "execute-consent-runtime-decision-kernel.ts",
    );
    const withdrawalModule = parsed(
      withdrawalKernel,
      "execute-consent-runtime-withdrawal-kernel.ts",
    );
    const transitionModule = parsed(transition, "execute-denial-transition.ts");
    const transitionTemplateModule = parsed(
      transitionTemplate,
      "execute-denial-transition.template.ts",
    );
    const forbiddenExecutors = new Set([
      "executeConsentRuntimeDecisionKernel",
      "executeConsentRuntimeWithdrawalKernel",
    ]);

    for (const module of [coordinatorModule, coordinatorTemplateModule]) {
      expect
        .soft(
          importedSymbols(module).filter(
            ({ imported, local }) =>
              forbiddenExecutors.has(imported) || forbiddenExecutors.has(local),
          ),
        )
        .toEqual([]);
      expect
        .soft(
          calledIdentifiers(module).filter((name) =>
            forbiddenExecutors.has(name),
          ),
        )
        .toEqual([]);
    }

    const generatedOutputs = await Promise.all(
      CONSENT_RUNTIME_MODEL.generatedLayers.map(async ({ output }) =>
        parsed(
          await readFile(
            new URL(`../../../${output}`, import.meta.url),
            "utf8",
          ),
          output,
        ),
      ),
    );
    const generatedTemplates = await Promise.all(
      CONSENT_RUNTIME_MODEL.generatedLayers.map(async ({ template }) =>
        parsed(
          await readFile(
            new URL(`../../../${template}`, import.meta.url),
            "utf8",
          ),
          template,
        ),
      ),
    );
    expect
      .soft(
        generatedOutputs.reduce(
          (count, module) => count + declarationCount(module, terminalOwner),
          0,
        ),
      )
      .toBe(1);
    expect
      .soft(
        generatedTemplates.reduce(
          (count, module) => count + declarationCount(module, terminalOwner),
          0,
        ),
      )
      .toBe(1);

    const ownerModulePath = "../transitions/execute-denial-transition.js";
    const coordinatorOwner = expectImportedOwner(
      coordinatorModule,
      ownerModulePath,
    );
    const decisionOwner = expectImportedOwner(decisionModule, ownerModulePath);
    const withdrawalOwner = expectImportedOwner(
      withdrawalModule,
      ownerModulePath,
    );
    expect
      .soft(
        coordinatorOwner === undefined
          ? false
          : reachesCall(coordinatorModule, "decide", coordinatorOwner),
      )
      .toBe(true);
    expect
      .soft(
        coordinatorOwner === undefined
          ? false
          : reachesCall(coordinatorModule, "withdraw", coordinatorOwner),
      )
      .toBe(true);
    expect
      .soft(
        decisionOwner === undefined
          ? false
          : reachesCall(
              decisionModule,
              "executeConsentRuntimeDecisionKernel",
              decisionOwner,
            ),
      )
      .toBe(true);
    expect
      .soft(
        withdrawalOwner === undefined
          ? false
          : reachesCall(
              withdrawalModule,
              "executeConsentRuntimeWithdrawalKernel",
              withdrawalOwner,
            ),
      )
      .toBe(true);
    expect
      .soft(
        reachesCall(transitionModule, "executeDenialTransition", terminalOwner),
      )
      .toBe(true);
    expect
      .soft(declarationCount(transitionTemplateModule, terminalOwner))
      .toBe(1);
  });

  it("binds model opcodes and removes coordinator denial mutation sinks", async () => {
    const [
      coordinator,
      coordinatorTemplate,
      transition,
      transitionTemplate,
      generator,
    ] = await Promise.all(
      [
        coordinatorUrl,
        coordinatorTemplateUrl,
        transitionUrl,
        transitionTemplateUrl,
        generatorUrl,
      ].map((url) => readFile(url, "utf8")),
    );
    const modules = [
      parsed(coordinator, "create-open-cookie-kernel.ts"),
      parsed(coordinatorTemplate, "create-open-cookie-kernel.template.ts"),
    ];
    for (const module of modules) {
      expect.soft(propertyCallCount(module, "compareAndSet")).toBe(2);
      expect.soft(propertyCallCount(module, "clearIfCurrent")).toBe(1);
      expect.soft(namedFunctions(module).has("clearFailedStage")).toBe(true);
      expect
        .soft(
          reachesCall(
            module,
            "clearFailedStage",
            "mustClearFailedStageExpected",
          ),
        )
        .toBe(true);
      expect
        .soft(
          stringLiteralCount(module, (value) => value.startsWith("denial-")),
        )
        .toBe(0);
      expect.soft(namedFunctions(module).has("executeTerminal")).toBe(false);
      expect.soft(namedFunctions(module).has("supersede")).toBe(false);
    }

    const model = CONSENT_RUNTIME_MODEL as typeof CONSENT_RUNTIME_MODEL & {
      readonly terminalInterpreter?: {
        readonly owner: { readonly layer: string; readonly symbol: string };
        readonly programs: typeof expectedTerminalPrograms;
      };
    };
    expect.soft(model.terminalInterpreter).toEqual({
      owner: {
        layer: "execute-denial-transition",
        symbol: terminalOwner,
      },
      programs: expectedTerminalPrograms,
    });
    expect.soft(CONSENT_RUNTIME_MODEL.lanes).toContain("persistence");
    expect
      .soft(CONSENT_RUNTIME_MODEL.coordinatorProtocol.expiry)
      .toEqual(["reconcile", "broadcast"]);

    const transitionModule = parsed(transition, "execute-denial-transition.ts");
    const templateModule = parsed(
      transitionTemplate,
      "execute-denial-transition.template.ts",
    );
    const generatorModule = parsed(generator, "generate-consent-runtime.mjs");
    expect
      .soft(
        syntaxValue(variableInitializer(transitionModule, "TERMINAL_PROGRAMS")),
      )
      .toEqual(expectedTerminalPrograms);
    expect
      .soft(propertyCallCount(transitionModule, "schedulePersistence"))
      .toBe(1);
    expect
      .soft(propertyCallCount(templateModule, "schedulePersistence"))
      .toBe(1);
    expect
      .soft(identifierCount(templateModule, "__TERMINAL_PROGRAMS__"))
      .toBe(1);
    expect
      .soft(
        hasReplaceBinding(
          generatorModule,
          "__TERMINAL_PROGRAMS__",
          "model.terminalInterpreter.programs",
        ),
      )
      .toBe(true);
  });

  it("keeps reject-all result parity across stateful and one-shot terminal programs", async () => {
    const { policySnapshot, resourcePolicy } = runtimePolicy();
    const clientOrder: string[] = [];
    const clientMemory = observedStore(null, clientOrder);
    const client = createOpenCookie({
      ...runtimePorts(clientMemory.store, clientOrder),
      consentDurationMs: 86_400_000,
      idGenerator: (kind) =>
        kind === "record" ? "record-1" : "transition-reject",
      now: () => 1_000,
      policySnapshot,
      resourcePolicy,
    });
    await client.initialize();
    clientOrder.length = 0;

    const clientResult = await client.rejectAll();
    const executorOrder: string[] = [];
    const executorMemory = observedStore(null, executorOrder);
    const executorResult = await executeConsentRuntimeDecision(
      runtimePorts(executorMemory.store, executorOrder),
      {
        decision: {
          decidedAt: 1_000,
          expiresAt: 86_401_000,
          method: "reject-all",
          recordId: "record-1",
        },
        now: 1_000,
        policySnapshot,
        resourcePolicy,
        transitionId: "transition-reject",
      },
    );

    expect(clientResult).toEqual(executorResult);
    expect(clientOrder).toEqual([
      "persist:reject-all",
      "broadcast:reject-all",
      "reconcile:reject-all",
      "receipt:reject-all",
    ]);
    expect(executorOrder).toEqual([
      "broadcast:reject-all",
      "reconcile:reject-all",
      "persist:reject-all",
      "receipt:reject-all",
    ]);
  });

  it("keeps withdrawal result parity across stateful and one-shot terminal programs", async () => {
    const { policySnapshot, resourcePolicy } = runtimePolicy();
    const clientOrder: string[] = [];
    const clientMemory = observedStore(null, clientOrder);
    const ids = ["record-1", "transition-grant", "transition-withdrawal"];
    let now = 1_000;
    const client = createOpenCookie({
      ...runtimePorts(clientMemory.store, clientOrder),
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected",
      now: () => now,
      policySnapshot,
      resourcePolicy,
    });
    await client.initialize();
    await client.acceptAll();
    const currentRecord = client.getSnapshot().record;
    if (currentRecord === undefined) throw new Error("Grant must be active.");
    clientOrder.length = 0;
    now = 2_000;

    const clientResult = await client.withdrawConsent();
    const executorOrder: string[] = [];
    const executorMemory = observedStore(
      { record: toPersistedDecisionRecord(currentRecord) },
      executorOrder,
    );
    const executorResult = await executeConsentRuntimeWithdrawal(
      runtimePorts(executorMemory.store, executorOrder),
      {
        currentRecord,
        now,
        policySnapshot,
        resourcePolicy,
        transitionId: "transition-withdrawal",
      },
    );

    expect(clientResult).toEqual(executorResult);
    expect(clientOrder).toEqual([
      "persist:withdrawal",
      "broadcast:withdrawal",
      "reconcile:withdrawal",
      "receipt:withdrawal",
    ]);
    expect(executorOrder).toEqual([
      "broadcast:withdrawal",
      "reconcile:withdrawal",
      "persist:withdrawal",
      "receipt:withdrawal",
    ]);
  });

  it.each(
    (["reject-all", "withdrawal"] as const).flatMap((intent) =>
      (
        [
          ["confirmed", undefined],
          ["conflict", "denial-persistence-conflict"],
          ["throw-clear", "denial-persistence-failed"],
          ["signal-failure", "denial-signal-broadcast-failed"],
          ["reconcile-failure", "denial-reconcile-failed"],
          ["receipt-failure", "denial-receipt-failed"],
        ] as const
      ).map(([fault, diagnostic]) => ({ diagnostic, fault, intent })),
    ),
  )(
    "keeps $intent $fault results equivalent across client and executor programs",
    async ({ diagnostic, fault, intent }) => {
      const { policySnapshot, resourcePolicy } = runtimePolicy();
      const activeRecord =
        intent === "withdrawal"
          ? decidedRecord(policySnapshot, "accept-all")
          : undefined;
      const initial = activeRecord
        ? { record: toPersistedDecisionRecord(activeRecord) }
        : null;
      const clientHarness = differentialHarness(initial);
      const ids = activeRecord
        ? ["transition-restore", "transition-terminal"]
        : ["record-1", "transition-terminal"];
      const client = createOpenCookie({
        ...clientHarness.ports,
        consentDurationMs: 86_400_000,
        idGenerator: () => ids.shift() ?? "unexpected",
        now: () => 2_000,
        policySnapshot,
        resourcePolicy,
      });
      await client.initialize();
      clientHarness.order.length = 0;
      clientHarness.setFault(fault);

      const clientResult =
        intent === "reject-all"
          ? await client.rejectAll()
          : await client.withdrawConsent();
      const executorHarness = differentialHarness(initial);
      executorHarness.setFault(fault);
      const executorResult =
        intent === "reject-all"
          ? await executeConsentRuntimeDecision(executorHarness.ports, {
              decision: {
                decidedAt: 2_000,
                expiresAt: 86_402_000,
                method: "reject-all",
                recordId: "record-1",
              },
              now: 2_000,
              policySnapshot,
              resourcePolicy,
              transitionId: "transition-terminal",
            })
          : await executeConsentRuntimeWithdrawal(executorHarness.ports, {
              currentRecord: requiredRecord(activeRecord),
              now: 2_000,
              policySnapshot,
              resourcePolicy,
              transitionId: "transition-terminal",
            });

      expect(clientResult).toEqual(executorResult);
      const clientPersist = clientHarness.order.indexOf(`persist:${intent}`);
      const clientBroadcast = clientHarness.order.indexOf(
        `broadcast:${intent}`,
      );
      const clientReconcile = clientHarness.order.indexOf(
        `reconcile:${intent}`,
      );
      const clientReceipt = clientHarness.order.indexOf(`receipt:${intent}`);
      expect(clientPersist).toBeGreaterThanOrEqual(0);
      expect(clientBroadcast).toBeGreaterThan(clientPersist);
      expect(clientReconcile).toBeGreaterThan(clientBroadcast);
      expect(clientReceipt).toBeGreaterThan(clientReconcile);
      const executorBroadcast = executorHarness.order.indexOf(
        `broadcast:${intent}`,
      );
      const executorReconcile = executorHarness.order.indexOf(
        `reconcile:${intent}`,
      );
      const executorPersist = executorHarness.order.indexOf(
        `persist:${intent}`,
      );
      const executorReceipt = executorHarness.order.indexOf(
        `receipt:${intent}`,
      );
      expect(executorBroadcast).toBeGreaterThanOrEqual(0);
      expect(executorReconcile).toBeGreaterThan(executorBroadcast);
      expect(executorPersist).toBeGreaterThan(executorReconcile);
      expect(executorReceipt).toBeGreaterThan(executorPersist);
      if (!("effect" in clientResult) || !("effect" in executorResult)) {
        throw new Error("Terminal matrix row must expose a final effect.");
      }
      const clientPendingEffect = clientHarness.effects.broadcast.at(-1);
      expect(clientHarness.effects.reconcile.at(-1)).toBe(clientPendingEffect);
      expect(clientResult.effect).not.toBe(clientPendingEffect);
      const executorPendingEffect = executorHarness.effects.commit.at(-1);
      expect(executorPendingEffect).toBe(
        executorHarness.effects.broadcast.at(-1),
      );
      expect(executorPendingEffect).toBe(
        executorHarness.effects.reconcile.at(-1),
      );
      expect(executorHarness.effects.notify.at(-1)).not.toBe(
        executorPendingEffect,
      );
      expect(executorHarness.effects.notify.at(-1)).toBe(executorResult.effect);
      if (diagnostic === undefined) {
        expect(clientResult.outcome).toBe("committed");
      } else {
        expect(clientResult).toMatchObject({
          diagnostics: [{ code: diagnostic }],
          outcome: "degraded",
        });
      }
    },
  );

  it("continues exact denial cleanup after the candidate clear throws", async () => {
    const { policySnapshot, resourcePolicy } = runtimePolicy();
    const activeRecord = decidedRecord(policySnapshot, "accept-all");
    const initial = { record: toPersistedDecisionRecord(activeRecord) };
    const clientHarness = differentialHarness(initial);
    const client = createOpenCookie({
      ...clientHarness.ports,
      consentDurationMs: 86_400_000,
      idGenerator: () => "transition-terminal",
      now: () => 2_000,
      policySnapshot,
      resourcePolicy,
    });
    await client.initialize();
    clientHarness.order.length = 0;
    clientHarness.setFault("candidate-clear-throws");

    const clientResult = await client.withdrawConsent();
    const executorHarness = differentialHarness(initial);
    executorHarness.setFault("candidate-clear-throws");
    const executorResult = await executeConsentRuntimeWithdrawal(
      executorHarness.ports,
      {
        currentRecord: activeRecord,
        now: 2_000,
        policySnapshot,
        resourcePolicy,
        transitionId: "transition-terminal",
      },
    );

    expect(clientResult).toEqual(executorResult);
    expect(clientResult).toMatchObject({
      diagnostics: [{ code: "denial-persistence-failed" }],
      outcome: "degraded",
    });
    expect(clientHarness.read()).toBeNull();
    expect(executorHarness.read()).toBeNull();
    expect(clientHarness.order).toEqual([
      "persist:withdrawal",
      "clear:withdrawal",
      "clear:accept-all",
      "broadcast:withdrawal",
      "reconcile:withdrawal",
      "receipt:withdrawal",
    ]);
    expect(executorHarness.order).toEqual([
      "broadcast:withdrawal",
      "reconcile:withdrawal",
      "persist:withdrawal",
      "clear:withdrawal",
      "clear:accept-all",
      "receipt:withdrawal",
    ]);
  });

  it("keeps low-level receipt rejection fatal and runtime receipt rejection degraded", async () => {
    const { policySnapshot, resourcePolicy } = runtimePolicy();
    const rejection = toPersistedDecisionRecord(
      decidedRecord(policySnapshot, "reject-all"),
    );
    const lowLevelOrder: string[] = [];
    const lowLevelMemory = observedStore(null, lowLevelOrder);

    await expect(
      executeDenialTransition(
        {
          broadcast: () => {
            lowLevelOrder.push("broadcast");
            return Promise.resolve();
          },
          commit: () => {
            lowLevelOrder.push("commit");
          },
          notify: () => {
            lowLevelOrder.push("notify");
          },
          receipt: () => {
            lowLevelOrder.push("receipt");
            return Promise.reject(new Error("receipt unavailable"));
          },
          reconcile: () => {
            lowLevelOrder.push("reconcile");
            return Promise.resolve();
          },
          store: lowLevelMemory.store,
        },
        {
          expectedRecord: null,
          rejection,
          transitionId: "transition-low-level",
        },
      ),
    ).rejects.toThrow("receipt unavailable");
    expect(lowLevelOrder).toEqual([
      "commit",
      "broadcast",
      "reconcile",
      "persist:reject-all",
      "receipt",
    ]);

    const runtimeHarness = differentialHarness(null);
    runtimeHarness.setFault("receipt-failure");
    const runtimeResult = await executeConsentRuntimeDecision(
      runtimeHarness.ports,
      {
        decision: {
          decidedAt: 1_000,
          expiresAt: 86_401_000,
          method: "reject-all",
          recordId: "record-1",
        },
        now: 1_000,
        policySnapshot,
        resourcePolicy,
        transitionId: "transition-runtime",
      },
    );
    expect(runtimeResult).toMatchObject({
      diagnostics: [{ code: "denial-receipt-failed" }],
      outcome: "degraded",
    });
    expect(runtimeHarness.effects.notify).toHaveLength(1);
  });

  it.each([
    "decision-rejected",
    "decision-unchanged",
    "withdrawal-rejected",
    "withdrawal-unchanged",
  ] as const)("keeps %s free of terminal port capture", async (caseName) => {
    const { policySnapshot, resourcePolicy } = runtimePolicy();
    const active = decidedRecord(policySnapshot, "accept-all");
    const denied = decidedRecord(policySnapshot, "reject-all");
    const withdrawn = withdrawConsent(active, 2_000);
    if (!withdrawn.ok || withdrawn.outcome !== "changed") {
      throw new Error("Withdrawal fixture must be valid.");
    }
    let descriptorReads = 0;
    let valueReads = 0;
    const hostileTarget = Object.create(null) as Record<string, unknown>;
    for (const field of [
      "broadcast",
      "commit",
      "notify",
      "receipt",
      "reconcile",
      "store",
    ]) {
      Object.defineProperty(hostileTarget, field, {
        configurable: true,
        get: () => {
          valueReads += 1;
          throw new Error("terminal port getter must remain untouched");
        },
      });
    }
    const hostilePorts = new Proxy(hostileTarget, {
      get: (target, property, receiver) => {
        valueReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
      getOwnPropertyDescriptor: (target, property) => {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    }) as Parameters<typeof executeConsentRuntimeDecision>[0];

    const result = caseName.startsWith("decision")
      ? await executeConsentRuntimeDecision(hostilePorts, {
          ...(caseName === "decision-unchanged"
            ? { currentRecord: denied }
            : {}),
          decision: {
            decidedAt: 1_000,
            expiresAt: caseName === "decision-rejected" ? 1_000 : 86_401_000,
            method: "reject-all",
            recordId: "record-1",
          },
          now: 1_000,
          policySnapshot,
          resourcePolicy,
          transitionId: "transition-terminal",
        })
      : await executeConsentRuntimeWithdrawal(hostilePorts, {
          currentRecord:
            caseName === "withdrawal-unchanged" ? withdrawn.record : active,
          now: caseName === "withdrawal-rejected" ? 500 : 3_000,
          policySnapshot,
          resourcePolicy,
          transitionId: "transition-terminal",
        });

    expect(result.outcome).toBe(
      caseName.endsWith("unchanged") ? "unchanged" : "rejected",
    );
    expect({ descriptorReads, valueReads }).toEqual({
      descriptorReads: 0,
      valueReads: 0,
    });
  });

  it("keeps withdrawal when it supersedes an active grant replacement", async () => {
    const { policySnapshot, resourcePolicy } = runtimePolicy([
      "analytics",
      "personalization",
    ]);
    const active = decidedRecord(policySnapshot, "accept-all");
    const order: string[] = [];
    const replacementEntered = deferred();
    const releaseReplacement = deferred();
    const terminalWritten = deferred();
    const receipts: ConsentReceipt[] = [];
    const memory = observedStore(
      { record: toPersistedDecisionRecord(active) },
      order,
      (candidate) => {
        if (candidate.record?.method === "withdrawal") {
          terminalWritten.resolve();
        }
      },
    );
    const ids = [
      "transition-restore",
      "transition-replacement",
      "transition-withdrawal",
    ];
    let now = 1_000;
    const client = createOpenCookie({
      broadcast: async (effect) => {
        order.push(`broadcast:${effect.transitionId}`);
        if (effect.transitionId === "transition-replacement") {
          replacementEntered.resolve();
          await releaseReplacement.promise;
        }
      },
      consentDurationMs: 86_400_000,
      idGenerator: () => ids.shift() ?? "unexpected",
      now: () => now,
      policySnapshot,
      receipt: (receipt) => {
        receipts.push(receipt);
        return Promise.resolve();
      },
      reconcile: (effect) => {
        order.push(`reconcile:${effect.transitionId}`);
        return Promise.resolve();
      },
      resourcePolicy,
      store: memory.store,
    });
    await client.initialize();
    order.length = 0;
    now = 2_000;
    const replacement = client.savePreferences(["analytics"]);
    await replacementEntered.promise;
    now = 3_000;
    const withdrawal = client.withdrawConsent();

    try {
      await terminalWritten.promise;
    } finally {
      releaseReplacement.resolve();
    }
    const [replacementResult, withdrawalResult] = await Promise.all([
      replacement,
      withdrawal,
    ]);
    expect(replacementResult.outcome).toBe("invalidated");
    expect(withdrawalResult).toMatchObject({
      effect: { record: { method: "withdrawal", withdrawnAt: 3_000 } },
      outcome: "committed",
    });
    expect(memory.read()?.record).toMatchObject({
      method: "withdrawal",
      withdrawnAt: 3_000,
    });
    expect(client.getSnapshot()).toMatchObject({
      grantActivation: "not-applicable",
      record: { method: "withdrawal", withdrawnAt: 3_000 },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      method: "withdrawal",
      occurredAt: 3_000,
      transitionId: "transition-withdrawal",
    });
  });

  it.each(["rejectAll", "withdrawConsent"] as const)(
    "keeps pending-grant %s reservation correction ahead of persistence and terminal effects",
    async (terminalIntent) => {
      const { policySnapshot, resourcePolicy } = runtimePolicy();
      const order: string[] = [];
      const grantEntered = deferred();
      const releaseGrant = deferred();
      const terminalWritten = deferred();
      const receipts: ConsentReceipt[] = [];
      let correctionBroadcast: ConsentRuntimeTransitionEffect | undefined;
      let correctionReconcile: ConsentRuntimeTransitionEffect | undefined;
      let terminalBroadcast: ConsentRuntimeTransitionEffect | undefined;
      let terminalReconcile: ConsentRuntimeTransitionEffect | undefined;
      let now = 1_000;
      const memory = observedStore(null, order, (candidate) => {
        if (candidate.record?.method === "reject-all") {
          terminalWritten.resolve();
        }
      });
      const ids = ["record-1", "transition-grant", "transition-terminal"];
      const client = createOpenCookie({
        broadcast: async (effect) => {
          const access = effect.runtime.effectiveAccess.resources[0]?.access;
          order.push(`broadcast:${effect.record.method}:${access}`);
          if (effect.record.method === "accept-all" && access === "allowed") {
            grantEntered.resolve();
            await releaseGrant.promise;
          } else if (effect.record.method === "accept-all") {
            correctionBroadcast = effect;
          } else {
            terminalBroadcast = effect;
          }
        },
        consentDurationMs: 86_400_000,
        idGenerator: () => ids.shift() ?? "unexpected",
        now: () => now,
        policySnapshot,
        receipt: (receipt) => {
          receipts.push(receipt);
          order.push(`receipt:${receipt.method}`);
          return Promise.resolve();
        },
        reconcile: (effect) => {
          const access = effect.runtime.effectiveAccess.resources[0]?.access;
          order.push(`reconcile:${effect.record.method}:${access}`);
          if (effect.record.method === "accept-all") {
            correctionReconcile = effect;
          } else {
            terminalReconcile = effect;
          }
          return Promise.resolve();
        },
        resourcePolicy,
        store: memory.store,
      });
      await client.initialize();
      const grant = client.acceptAll();
      await grantEntered.promise;
      order.length = 0;
      now = 2_000;

      const terminalPromise =
        terminalIntent === "rejectAll"
          ? client.rejectAll()
          : client.withdrawConsent();
      await terminalWritten.promise;
      releaseGrant.resolve();
      const [grantResult, terminalResult] = await Promise.all([
        grant,
        terminalPromise,
      ]);

      expect(grantResult.outcome).toBe("invalidated");
      expect(terminalResult.outcome).toBe("committed");
      expect(memory.read()?.record?.method).toBe("reject-all");
      expect(client.getSnapshot()).toMatchObject({
        grantActivation: "not-applicable",
        record: { method: "reject-all" },
      });
      const persistence = order.indexOf("persist:reject-all");
      const correction = order.indexOf("broadcast:accept-all:blocked");
      const correctionReconciliation = order.indexOf(
        "reconcile:accept-all:blocked",
      );
      const terminalSignal = order.indexOf("broadcast:reject-all:blocked");
      const terminalReceipt = order.indexOf("receipt:reject-all");
      expect(correction).toBeGreaterThanOrEqual(0);
      expect(correctionReconciliation).toBeGreaterThan(correction);
      expect(persistence).toBeGreaterThan(correctionReconciliation);
      expect(terminalSignal).toBeGreaterThan(persistence);
      expect(terminalReceipt).toBeGreaterThan(terminalSignal);
      expect(correctionReconcile).toBe(correctionBroadcast);
      expect(terminalReconcile).toBe(terminalBroadcast);
      if (!("effect" in terminalResult)) {
        throw new Error("Terminal supersession must expose a final effect.");
      }
      expect(terminalResult.effect).not.toBe(terminalBroadcast);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        method: "reject-all",
        occurredAt: 2_000,
        transitionId: "transition-terminal",
      });
    },
  );
});
