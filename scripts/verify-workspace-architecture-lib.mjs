import { posix as path } from "node:path";

import ts from "typescript";

const REQUIRED_RULES = [
  "domain-no-outward-imports",
  "application-no-infrastructure",
  "application-domain-entrypoints-only",
  "context-no-peer-internals",
  "core-no-adapters",
  "adapter-no-peer-adapter",
  "adapter-no-core-internals",
  "core-source-no-external-runtime",
  "no-circular",
  "no-unresolvable",
];

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const RUNTIME_DEPENDENCY_FIELDS = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
];

const FRAMEWORK_WRAPPER_DEPENDENCIES = new Map([
  ["@opencookie-dev/astro", new Set(["@opencookie-dev/vanilla"])],
  ["@opencookie-dev/next", new Set(["@opencookie-dev/react"])],
  ["@opencookie-dev/nuxt", new Set(["@opencookie-dev/vue"])],
]);

export const BUDGETS = new Map([
  [
    "core browser ESM",
    {
      packageName: "core",
      exactBytes: 27_708,
      expectedPath: "packages/core/dist/index.js",
      compression: "gzip",
    },
  ],
  [
    "core domain ESM",
    {
      packageName: "core domain",
      exactBytes: 10_543,
      expectedPath: "packages/core/dist/domain.js",
      compression: "gzip",
    },
  ],
  [
    "core application ESM",
    {
      packageName: "core application",
      exactBytes: 14_220,
      expectedPath: "packages/core/dist/application.js",
      compression: "gzip",
    },
  ],
  [
    "core reconciliation ESM",
    {
      packageName: "core reconciliation",
      exactBytes: 7_941,
      expectedPath: "packages/core/dist/reconciliation.js",
      compression: "gzip",
    },
  ],
  [
    "core infrastructure ESM",
    {
      packageName: "core infrastructure",
      exactBytes: 5_789,
      expectedPath: "packages/core/dist/infrastructure.js",
      compression: "gzip",
    },
  ],
  [
    "core auto ESM",
    {
      packageName: "core auto",
      exactBytes: 26_121,
      expectedPath: "packages/core/dist/auto.js",
      compression: "gzip",
    },
  ],
  [
    "vanilla auto IIFE",
    {
      packageName: "vanilla",
      exactBytes: 45_000,
      expectedPath: "packages/adapters/vanilla/dist/auto.iife.js",
      compression: "gzip",
    },
  ],
  [
    "vanilla auto IIFE raw",
    {
      packageName: "vanilla raw",
      exactBytes: 150_000,
      expectedPath: "packages/adapters/vanilla/dist/auto.iife.js",
      compression: "none",
    },
  ],
]);

const CORE_EXPORTS = new Map([
  [".", "packages/core/dist/index.js"],
  ["./application", "packages/core/dist/application.js"],
  ["./auto", "packages/core/dist/auto.js"],
  ["./domain", "packages/core/dist/domain.js"],
  ["./infrastructure", "packages/core/dist/infrastructure.js"],
  ["./reconciliation", "packages/core/dist/reconciliation.js"],
]);

const CORE_API_CONFIGS = [
  "api-extractor.application.json",
  "api-extractor.auto.json",
  "api-extractor.domain.json",
  "api-extractor.infrastructure.json",
  "api-extractor.reconciliation.json",
  "api-extractor.json",
];

const CORE_API_REPORTS = [
  "core-application.api.md",
  "core-auto.api.md",
  "core-domain.api.md",
  "core-infrastructure.api.md",
  "core-reconciliation.api.md",
  "core.api.md",
];

const DIRECT_BROWSER_PRIMITIVES = new Map([
  ["fetch", "fetch"],
  ["XMLHttpRequest", "XMLHttpRequest"],
  ["WebSocket", "WebSocket"],
  ["EventSource", "EventSource"],
  ["Worker", "Worker"],
  ["SharedWorker", "SharedWorker"],
  ["WebTransport", "WebTransport"],
  ["importScripts", "importScripts"],
]);

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

const GLOBAL_BROWSER_OBJECT_NAMES = new Set(["globalThis", "self", "window"]);

const DIRECT_BROWSER_ROOT_NAMES = new Set([
  ...GLOBAL_BROWSER_OBJECT_NAMES,
  "Audio",
  "AudioContext",
  "CSS",
  "Image",
  "Reflect",
  "document",
  "location",
  "navigator",
  "open",
  "webkitAudioContext",
]);

const SAFE_DIRECT_REFLECT_METHODS = new Set(["apply", "has", "ownKeys"]);

const AMBIGUOUS_BROWSER_PROVENANCE = "ambiguous-browser-provenance";

const MUTABLE_WRITES_BY_BINDINGS = new WeakMap();

const RESOURCE_URL_PROPERTIES = new Set([
  "action",
  "data",
  "formaction",
  "href",
  "poster",
  "src",
  "srcset",
]);

function normalizeSourcePath(sourcePath) {
  return String(sourcePath).replaceAll("\\", "/");
}

function browserPackageDirectoryAt(sourcePath) {
  const normalizedPath = normalizeSourcePath(sourcePath);
  if (
    normalizedPath === "packages/core/src" ||
    normalizedPath.startsWith("packages/core/src/")
  ) {
    return "packages/core";
  }
  return normalizedPath.match(
    /^(packages\/adapters\/[^/]+)\/src(?:\/|$)/u,
  )?.[1];
}

function isBrowserSourcePath(sourcePath) {
  return browserPackageDirectoryAt(sourcePath) !== undefined;
}

function isSourceCodePath(sourcePath) {
  const normalizedPath = normalizeSourcePath(sourcePath);
  return (
    /[.](?:[cm]?[jt]sx?)$/u.test(normalizedPath) &&
    !/[.]d[.][cm]?ts$/u.test(normalizedPath)
  );
}

function isExcludedLookingSource(sourcePath) {
  const normalizedPath = normalizeSourcePath(sourcePath);
  return (
    /[.](?:spec|test|test-helper)[.][cm]?[jt]sx?$/u.test(normalizedPath) ||
    /\/(?:__fixtures__|__tests__|fixtures?|test-fixtures?)\//u.test(
      normalizedPath,
    )
  );
}

function isShippedBrowserProductionSource(sourcePath) {
  return (
    isBrowserSourcePath(sourcePath) &&
    isSourceCodePath(sourcePath) &&
    !isExcludedLookingSource(sourcePath)
  );
}

function scriptKindFor(sourcePath) {
  if (/[.]tsx$/u.test(sourcePath)) return ts.ScriptKind.TSX;
  if (/[.]jsx$/u.test(sourcePath)) return ts.ScriptKind.JSX;
  if (/[.](?:mjs|cjs|js)$/u.test(sourcePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function lexicalScopeAt(node) {
  for (let current = node; current !== undefined; current = current.parent) {
    if (
      ts.isSourceFile(current) ||
      ts.isFunctionLike(current) ||
      ts.isBlock(current) ||
      ts.isCaseBlock(current) ||
      ts.isCatchClause(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current)
    ) {
      return current;
    }
  }
  return undefined;
}

function functionScopeAt(node) {
  for (let current = node; current !== undefined; current = current.parent) {
    if (ts.isSourceFile(current) || ts.isFunctionLike(current)) return current;
  }
  return undefined;
}

function addBinding(bindings, scope, name, declaration) {
  if (scope === undefined) return;
  let scopeBindings = bindings.get(scope);
  if (scopeBindings === undefined) {
    scopeBindings = new Map();
    bindings.set(scope, scopeBindings);
  }
  scopeBindings.set(name.text, { declaration, name });
}

function addBindingName(bindings, scope, name, declaration) {
  if (ts.isIdentifier(name)) {
    addBinding(bindings, scope, name, declaration);
    return;
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        addBindingName(bindings, scope, element.name, declaration);
      }
    }
  }
}

function collectBindings(sourceFile) {
  const bindings = new Map();

  function visit(node) {
    if (ts.isVariableDeclaration(node)) {
      const declarationList = node.parent;
      const isBlockScoped =
        ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
      const scope = ts.isCatchClause(declarationList)
        ? declarationList
        : isBlockScoped
          ? lexicalScopeAt(declarationList.parent)
          : functionScopeAt(declarationList.parent);
      addBindingName(bindings, scope, node.name, node);
    } else if (ts.isParameter(node)) {
      addBindingName(
        bindings,
        ts.isCatchClause(node.parent)
          ? node.parent
          : functionScopeAt(node.parent),
        node.name,
        node,
      );
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      addBinding(bindings, lexicalScopeAt(node.parent), node.name, node);
    } else if (ts.isFunctionExpression(node) && node.name !== undefined) {
      addBinding(bindings, node, node.name, node);
    } else if (ts.isClassDeclaration(node) && node.name !== undefined) {
      addBinding(bindings, lexicalScopeAt(node.parent), node.name, node);
    } else if (ts.isClassExpression(node) && node.name !== undefined) {
      addBinding(bindings, node, node.name, node);
    } else if (
      (ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) &&
      ts.isIdentifier(node.name)
    ) {
      addBinding(bindings, lexicalScopeAt(node.parent), node.name, node);
    } else if (ts.isImportClause(node)) {
      if (node.name !== undefined) {
        addBinding(bindings, sourceFile, node.name, node);
      }
    } else if (ts.isNamespaceImport(node)) {
      addBinding(bindings, sourceFile, node.name, node);
    } else if (ts.isImportSpecifier(node)) {
      addBinding(bindings, sourceFile, node.name, node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      addBinding(bindings, sourceFile, node.name, node);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  MUTABLE_WRITES_BY_BINDINGS.set(
    bindings,
    collectMutableBindingWrites(sourceFile, bindings),
  );
  return bindings;
}

function resolveBinding(bindings, identifier) {
  for (
    let current = identifier.parent;
    current !== undefined;
    current = current.parent
  ) {
    const declaration = bindings.get(current)?.get(identifier.text);
    if (declaration !== undefined) return declaration;
  }
  return undefined;
}

function addMutableBindingWrite(writes, binding, write) {
  let bindingWrites = writes.get(binding);
  if (bindingWrites === undefined) {
    bindingWrites = [];
    writes.set(binding, bindingWrites);
  }
  bindingWrites.push(write);
}

function recordAssignmentTarget(
  target,
  source,
  bindings,
  writes,
  properties = [],
  uncertain = false,
) {
  const expression = unwrapExpression(target);
  if (ts.isIdentifier(expression)) {
    const binding = resolveBinding(bindings, expression);
    if (binding !== undefined) {
      addMutableBindingWrite(writes, binding, {
        properties,
        source,
        uncertain,
      });
    }
    return;
  }

  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      recordAssignmentTarget(
        expression.left,
        source,
        bindings,
        writes,
        properties,
        true,
      );
      recordAssignmentTarget(
        expression.left,
        expression.right,
        bindings,
        writes,
        [],
        true,
      );
    }
    return;
  }

  if (ts.isObjectLiteralExpression(expression)) {
    for (const property of expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        recordAssignmentTarget(
          property.expression,
          source,
          bindings,
          writes,
          properties,
          true,
        );
        continue;
      }
      if (
        !ts.isPropertyAssignment(property) &&
        !ts.isShorthandPropertyAssignment(property)
      ) {
        continue;
      }
      const propertyName = staticPropertyName(property.name, bindings);
      const nestedTarget = ts.isPropertyAssignment(property)
        ? property.initializer
        : property.name;
      recordAssignmentTarget(
        nestedTarget,
        source,
        bindings,
        writes,
        propertyName === undefined ? properties : [...properties, propertyName],
        uncertain ||
          propertyName === undefined ||
          (ts.isShorthandPropertyAssignment(property) &&
            property.objectAssignmentInitializer !== undefined),
      );
      if (
        ts.isShorthandPropertyAssignment(property) &&
        property.objectAssignmentInitializer !== undefined
      ) {
        recordAssignmentTarget(
          property.name,
          property.objectAssignmentInitializer,
          bindings,
          writes,
          [],
          true,
        );
      }
    }
    return;
  }

  if (ts.isArrayLiteralExpression(expression)) {
    const sourceExpression =
      source === undefined ? undefined : unwrapExpression(source);
    const sourceElements =
      sourceExpression !== undefined &&
      ts.isArrayLiteralExpression(sourceExpression)
        ? sourceExpression.elements
        : undefined;

    for (const [index, element] of expression.elements.entries()) {
      if (ts.isOmittedExpression(element)) continue;

      if (ts.isSpreadElement(element)) {
        if (sourceElements === undefined) {
          recordAssignmentTarget(
            element.expression,
            source,
            bindings,
            writes,
            properties,
            true,
          );
          continue;
        }

        const remainingElements = sourceElements.slice(index);
        if (remainingElements.length === 0) {
          recordAssignmentTarget(
            element.expression,
            undefined,
            bindings,
            writes,
            properties,
            true,
          );
        }
        for (const sourceElement of remainingElements) {
          recordAssignmentTarget(
            element.expression,
            ts.isOmittedExpression(sourceElement)
              ? undefined
              : ts.isSpreadElement(sourceElement)
                ? sourceElement.expression
                : sourceElement,
            bindings,
            writes,
            properties,
            true,
          );
        }
        continue;
      }

      const sourceElement = sourceElements?.[index];
      recordAssignmentTarget(
        element,
        sourceElements === undefined
          ? source
          : sourceElement === undefined || ts.isOmittedExpression(sourceElement)
            ? undefined
            : ts.isSpreadElement(sourceElement)
              ? sourceElement.expression
              : sourceElement,
        bindings,
        writes,
        properties,
        uncertain ||
          sourceElements === undefined ||
          sourceElement === undefined ||
          ts.isOmittedExpression(sourceElement) ||
          ts.isSpreadElement(sourceElement),
      );
    }
  }
}

function collectMutableBindingWrites(sourceFile, bindings) {
  const writes = new Map();

  function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const exactAssignment =
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      recordAssignmentTarget(
        node.left,
        node.right,
        bindings,
        writes,
        [],
        !exactAssignment,
      );
      if (!exactAssignment) {
        recordAssignmentTarget(
          node.left,
          undefined,
          bindings,
          writes,
          [],
          true,
        );
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      recordAssignmentTarget(
        node.operand,
        undefined,
        bindings,
        writes,
        [],
        true,
      );
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      recordAssignmentTarget(
        node.initializer,
        undefined,
        bindings,
        writes,
        [],
        true,
      );
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return writes;
}

function isConstVariableDeclaration(node) {
  return (
    node !== undefined &&
    ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticallyKnownString(node, bindings, seen = new Set()) {
  const expression = unwrapExpression(node);
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticallyKnownString(expression.left, bindings, seen);
    const right = staticallyKnownString(expression.right, bindings, seen);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const substitution = staticallyKnownString(
        span.expression,
        bindings,
        seen,
      );
      if (substitution === undefined) return undefined;
      value += substitution + span.literal.text;
    }
    return value;
  }
  if (ts.isIdentifier(expression)) {
    const binding = resolveBinding(bindings, expression);
    const declaration = binding?.declaration;
    if (
      !isConstVariableDeclaration(declaration) ||
      !ts.isIdentifier(declaration.name) ||
      declaration.name !== binding.name ||
      declaration.initializer === undefined ||
      seen.has(declaration)
    ) {
      return undefined;
    }
    seen.add(declaration);
    const value = staticallyKnownString(
      declaration.initializer,
      bindings,
      seen,
    );
    seen.delete(declaration);
    return value;
  }
  return undefined;
}

function staticPropertyName(node, bindings) {
  if (node === undefined) return undefined;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isComputedPropertyName(node)) {
    return staticallyKnownString(node.expression, bindings);
  }
  return staticallyKnownString(node, bindings);
}

function transportKind(label) {
  return `transport:${label}`;
}

function transportAtKind(kind) {
  return kind?.startsWith("transport:") === true
    ? kind.slice("transport:".length)
    : undefined;
}

function browserPropertyKind(baseKind, propertyName) {
  if (baseKind === AMBIGUOUS_BROWSER_PROVENANCE) {
    return AMBIGUOUS_BROWSER_PROVENANCE;
  }
  if (baseKind === "global") {
    const transport = DIRECT_BROWSER_PRIMITIVES.get(propertyName);
    if (transport !== undefined) return transportKind(transport);
    if (propertyName === "navigator") return "navigator";
    if (propertyName === "CSS") return "css";
    if (propertyName === "Reflect") return "reflect";
    if (propertyName === "document") return "document";
    if (propertyName === "location") return "location";
    if (propertyName === "open") return "endpoint-loader";
    if (
      propertyName === "AudioContext" ||
      propertyName === "webkitAudioContext"
    ) {
      return "audio-context-constructor";
    }
    if (propertyName === "Image") return "image-constructor";
    if (propertyName === "Audio") return "audio-constructor";
    if (GLOBAL_BROWSER_OBJECT_NAMES.has(propertyName)) return "global";
  }
  if (baseKind === "navigator") {
    if (propertyName === "sendBeacon") return transportKind("sendBeacon");
    if (propertyName === "serviceWorker") return "service-worker";
  }
  if (baseKind === "document" && propertyName === "location") {
    return "location";
  }
  if (baseKind === "document" && propertyName === "defaultView") {
    return "global";
  }
  if (baseKind === "service-worker" && propertyName === "register") {
    return transportKind("serviceWorker registration");
  }
  if (baseKind === "css" && /Worklet$/u.test(propertyName)) return "worklet";
  if (baseKind === "audio-context" && propertyName === "audioWorklet") {
    return "worklet";
  }
  if (baseKind === "worklet" && propertyName === "addModule") {
    return transportKind("worklet addModule");
  }
  if (baseKind === "reflect" && propertyName === "get") {
    return "reflect-get";
  }
  if (baseKind === "document" && propertyName === "createElement") {
    return "document-create-element";
  }
  if (
    baseKind === "location" &&
    (propertyName === "assign" || propertyName === "replace")
  ) {
    return "endpoint-loader";
  }
  if (baseKind === "resource-element" && propertyName === "setAttribute") {
    return "resource-set-attribute";
  }
  if (baseKind === "xml-http-request" && propertyName === "open") {
    return "xml-http-request-open";
  }
  return undefined;
}

function bindingPropertyPath(pattern, target, bindings) {
  if (ts.isIdentifier(pattern)) return pattern === target ? [] : undefined;
  if (!ts.isObjectBindingPattern(pattern)) return undefined;
  for (const element of pattern.elements) {
    const nested = bindingPropertyPath(element.name, target, bindings);
    if (nested === undefined) continue;
    return [
      staticPropertyName(element.propertyName ?? element.name, bindings),
      ...nested,
    ];
  }
  return undefined;
}

function browserKindAtPropertyPath(source, properties, bindings, seen) {
  if (source === undefined || properties === undefined) return undefined;
  let kind = browserValueKind(source, bindings, seen);
  for (const propertyName of properties) {
    if (kind === undefined || propertyName === undefined) return undefined;
    kind = browserPropertyKind(kind, propertyName);
  }
  return kind;
}

function mergeBrowserKindCandidates(candidates) {
  const knownKinds = candidates
    .map(({ kind }) => kind)
    .filter((kind) => kind !== undefined);
  if (knownKinds.length === 0) return undefined;
  if (
    knownKinds.includes(AMBIGUOUS_BROWSER_PROVENANCE) ||
    candidates.some(({ kind, uncertain }) =>
      kind === undefined ? true : uncertain,
    ) ||
    new Set(knownKinds).size > 1
  ) {
    return AMBIGUOUS_BROWSER_PROVENANCE;
  }
  return knownKinds[0];
}

function isStaticallyAbsentBrowserValue(node, bindings) {
  const expression = unwrapExpression(node);
  return (
    expression.kind === ts.SyntaxKind.NullKeyword ||
    ts.isVoidExpression(expression) ||
    (ts.isIdentifier(expression) &&
      expression.text === "undefined" &&
      resolveBinding(bindings, expression) === undefined)
  );
}

function bindingValueKind(binding, bindings, seen) {
  if (seen.has(binding)) return undefined;
  seen.add(binding);

  try {
    const candidates = [];
    const declaration = binding.declaration;
    if (
      (ts.isVariableDeclaration(declaration) || ts.isParameter(declaration)) &&
      declaration.initializer !== undefined
    ) {
      const properties = bindingPropertyPath(
        declaration.name,
        binding.name,
        bindings,
      );
      candidates.push({
        kind: browserKindAtPropertyPath(
          declaration.initializer,
          properties,
          bindings,
          seen,
        ),
        uncertain: properties === undefined,
      });
    }

    for (const write of MUTABLE_WRITES_BY_BINDINGS.get(bindings)?.get(
      binding,
    ) ?? []) {
      candidates.push({
        kind: browserKindAtPropertyPath(
          write.source,
          write.properties,
          bindings,
          seen,
        ),
        uncertain: write.uncertain,
      });
    }

    return mergeBrowserKindCandidates(candidates);
  } finally {
    seen.delete(binding);
  }
}

function browserValueKind(node, bindings, seen = new Set()) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    const binding = resolveBinding(bindings, expression);
    if (binding !== undefined) return bindingValueKind(binding, bindings, seen);
    if (GLOBAL_BROWSER_OBJECT_NAMES.has(expression.text)) return "global";
    if (expression.text === "navigator") return "navigator";
    if (expression.text === "CSS") return "css";
    if (expression.text === "Reflect") return "reflect";
    if (expression.text === "document") return "document";
    if (expression.text === "location") return "location";
    if (expression.text === "open") return "endpoint-loader";
    if (
      expression.text === "AudioContext" ||
      expression.text === "webkitAudioContext"
    ) {
      return "audio-context-constructor";
    }
    if (expression.text === "Image") return "image-constructor";
    if (expression.text === "Audio") return "audio-constructor";
    const transport = DIRECT_BROWSER_PRIMITIVES.get(expression.text);
    return transport === undefined ? undefined : transportKind(transport);
  }
  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return browserValueKind(expression.right, bindings, seen);
    }
    if (
      expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return mergeBrowserKindCandidates(
        [expression.left, expression.right]
          .filter((branch) => !isStaticallyAbsentBrowserValue(branch, bindings))
          .map((branch) => ({
            kind: browserValueKind(branch, bindings, seen),
            uncertain: false,
          })),
      );
    }
  }
  if (ts.isCommaListExpression(expression)) {
    return browserValueKind(
      expression.elements[expression.elements.length - 1],
      bindings,
      seen,
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return mergeBrowserKindCandidates(
      [expression.whenTrue, expression.whenFalse]
        .filter((branch) => !isStaticallyAbsentBrowserValue(branch, bindings))
        .map((branch) => ({
          kind: browserValueKind(branch, bindings, seen),
          uncertain: false,
        })),
    );
  }
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    const baseKind = browserValueKind(expression.expression, bindings, seen);
    const propertyName = ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : staticallyKnownString(expression.argumentExpression, bindings);
    return baseKind === undefined || propertyName === undefined
      ? undefined
      : browserPropertyKind(baseKind, propertyName);
  }
  if (ts.isNewExpression(expression)) {
    const constructorKind = browserValueKind(
      expression.expression,
      bindings,
      seen,
    );
    if (constructorKind === AMBIGUOUS_BROWSER_PROVENANCE) {
      return AMBIGUOUS_BROWSER_PROVENANCE;
    }
    if (constructorKind === "audio-context-constructor") {
      return "audio-context";
    }
    if (
      constructorKind === "image-constructor" ||
      constructorKind === "audio-constructor"
    ) {
      return "resource-element";
    }
    if (transportAtKind(constructorKind) === "XMLHttpRequest") {
      return "xml-http-request";
    }
  }
  if (ts.isCallExpression(expression)) {
    const calleeKind = browserValueKind(expression.expression, bindings, seen);
    if (calleeKind === AMBIGUOUS_BROWSER_PROVENANCE) {
      return AMBIGUOUS_BROWSER_PROVENANCE;
    }
    if (calleeKind === "reflect-get" && expression.arguments.length >= 2) {
      const baseKind = browserValueKind(
        expression.arguments[0],
        bindings,
        seen,
      );
      const propertyName = staticallyKnownString(
        expression.arguments[1],
        bindings,
      );
      return baseKind === undefined || propertyName === undefined
        ? undefined
        : browserPropertyKind(baseKind, propertyName);
    }
    if (
      calleeKind === "document-create-element" &&
      expression.arguments.length >= 1 &&
      staticallyKnownString(expression.arguments[0], bindings) !== undefined
    ) {
      return "resource-element";
    }
  }
  return undefined;
}

function browserObjectKind(node, bindings, seen = new Set()) {
  return browserValueKind(node, bindings, seen);
}

function forbiddenProperty(baseKind, propertyName) {
  return transportAtKind(browserPropertyKind(baseKind, propertyName));
}

function isIdentifierPropertyName(node) {
  const parent = node.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    ((ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent)) &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    (ts.isImportSpecifier(parent) &&
      (parent.name === node || parent.propertyName === node)) ||
    (ts.isExportSpecifier(parent) &&
      (parent.name === node || parent.propertyName === node)) ||
    (ts.isEnumMember(parent) && parent.name === node) ||
    ts.isLabeledStatement(parent) ||
    (ts.isBreakOrContinueStatement(parent) && parent.label === node)
  );
}

function isTypeOnlyDeclarationName(node) {
  const parent = node.parent;
  return (
    ((ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent)) &&
      parent.name === node) ||
    (ts.isImportClause(parent) && parent.isTypeOnly && parent.name === node) ||
    (ts.isImportSpecifier(parent) &&
      parent.isTypeOnly &&
      parent.name === node) ||
    (ts.isExportSpecifier(parent) && parent.isTypeOnly && parent.name === node)
  );
}

function isRuntimeIdentifierReference(node) {
  return (
    !ts.isPartOfTypeNode(node) &&
    !isTypeOnlyDeclarationName(node) &&
    !isIdentifierPropertyName(node)
  );
}

function outerExpression(node) {
  let current = node;
  while (
    current.parent !== undefined &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

function enclosingVariableDeclaration(node) {
  for (
    let current = node.parent;
    current !== undefined && !ts.isSourceFile(current);
    current = current.parent
  ) {
    if (ts.isVariableDeclaration(current)) return current;
  }
  return undefined;
}

function isNamedVariableDeclaration(node, name) {
  const declaration = enclosingVariableDeclaration(node);
  return (
    declaration !== undefined &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === name
  );
}

function directRootPropertyAccess(node) {
  const root = outerExpression(node);
  const parent = root.parent;
  return parent !== undefined &&
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === root
    ? parent
    : undefined;
}

function isAllowedVanillaAutoGlobalThis(node, sourcePath) {
  if (sourcePath !== "packages/adapters/vanilla/src/auto.ts") return false;
  const access = directRootPropertyAccess(node);
  if (access === undefined) return false;

  if (access.name.text === "OpenCookie") {
    const assignment = access.parent;
    return (
      ts.isBinaryExpression(assignment) &&
      assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      assignment.left === access
    );
  }

  if (
    access.name.text !== "document" ||
    !isNamedVariableDeclaration(node, "resolvedDocument")
  ) {
    return false;
  }
  return (
    (ts.isTypeOfExpression(access.parent) &&
      access.parent.expression === access) ||
    (ts.isConditionalExpression(access.parent) &&
      access.parent.whenFalse === access)
  );
}

function isAllowedDocumentFallback(node, sourcePath) {
  if (
    sourcePath !== "packages/adapters/vanilla/src/runtime-guards.ts" ||
    !isNamedVariableDeclaration(node, "resolved")
  ) {
    return false;
  }
  const expression = outerExpression(node);
  return (
    (ts.isTypeOfExpression(expression.parent) &&
      expression.parent.expression === expression) ||
    (ts.isConditionalExpression(expression.parent) &&
      expression.parent.whenFalse === expression)
  );
}

function isAllowedDirectReflect(node, sourcePath, bindings) {
  const access = directRootPropertyAccess(node);
  if (access === undefined || !ts.isCallExpression(access.parent)) return false;
  const call = access.parent;
  if (call.expression !== access) return false;
  if (SAFE_DIRECT_REFLECT_METHODS.has(access.name.text)) return true;
  if (
    access.name.text !== "get" ||
    sourcePath !==
      "packages/core/src/domain/consent-decisioning/evaluate-consent.ts" ||
    call.arguments.length !== 2 ||
    !ts.isIdentifier(call.arguments[0]) ||
    call.arguments[0].text !== "decision"
  ) {
    return false;
  }
  const propertyName = staticallyKnownString(call.arguments[1], bindings);
  return propertyName === "purposeId" || propertyName === "value";
}

function isAllowedDirectBrowserRoot(node, sourcePath, bindings) {
  if (node.text === "globalThis") {
    return isAllowedVanillaAutoGlobalThis(node, sourcePath);
  }
  if (node.text === "document") {
    return isAllowedDocumentFallback(node, sourcePath);
  }
  if (node.text === "window") {
    const expression = outerExpression(node);
    return (
      ts.isTypeOfExpression(expression.parent) &&
      expression.parent.expression === expression
    );
  }
  if (node.text === "Reflect") {
    return isAllowedDirectReflect(node, sourcePath, bindings);
  }
  return false;
}

function isWithinDestructuringAssignmentTarget(node) {
  for (
    let current = node;
    current.parent !== undefined;
    current = current.parent
  ) {
    const parent = current.parent;
    if (
      !ts.isBinaryExpression(parent) ||
      parent.operatorToken.kind < ts.SyntaxKind.FirstAssignment ||
      parent.operatorToken.kind > ts.SyntaxKind.LastAssignment
    ) {
      continue;
    }

    const left = unwrapExpression(parent.left);
    if (
      (ts.isObjectLiteralExpression(left) ||
        ts.isArrayLiteralExpression(left)) &&
      node.pos >= left.pos &&
      node.end <= left.end
    ) {
      return true;
    }
  }
  return false;
}

function urlShapedValue(value) {
  return /[a-z][a-z0-9+.-]*:\/\/|\/\/(?:[$][{]|[a-z0-9.[\]_-])/iu.test(value);
}

function templateHasUrlShape(node) {
  if (!ts.isTemplateExpression(node)) return false;
  if (node.templateSpans.length > 0 && node.head.text.endsWith("//")) {
    return true;
  }
  return [
    node.head.text,
    ...node.templateSpans.map((span) => span.literal.text),
  ].some((part) => urlShapedValue(part));
}

function endpointValueExpression(node, bindings) {
  const expression = unwrapExpression(node);
  if (
    ts.isNewExpression(expression) &&
    isUnboundRuntimeIdentifier(expression.expression, "URL", bindings) &&
    expression.arguments?.[0] !== undefined
  ) {
    return endpointValueExpression(expression.arguments[0], bindings);
  }
  return expression;
}

function isUnboundRuntimeIdentifier(node, name, bindings) {
  return (
    ts.isIdentifier(node) &&
    node.text === name &&
    resolveBinding(bindings, node) === undefined
  );
}

function importSpecifiers(sourceFile) {
  const specifiers = [];

  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return specifiers;
}

function resolveRelativeSource(importerPath, specifier, sourceByPath) {
  if (!specifier.startsWith(".")) return undefined;
  const basePath = path.normalize(
    path.join(path.dirname(importerPath), specifier),
  );
  const candidates = [basePath];
  const extension = path.extname(basePath);

  if (SOURCE_EXTENSIONS.includes(extension)) {
    const stem = basePath.slice(0, -extension.length);
    for (const sourceExtension of SOURCE_EXTENSIONS) {
      candidates.push(stem + sourceExtension);
    }
  } else {
    for (const sourceExtension of SOURCE_EXTENSIONS) {
      candidates.push(basePath + sourceExtension);
      candidates.push(path.join(basePath, `index${sourceExtension}`));
    }
  }

  return candidates.find((candidate) => sourceByPath.has(candidate));
}

function parseBrowserSource(item, issues) {
  const sourceFile = ts.createSourceFile(
    item.path,
    item.source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(item.path),
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    const first = sourceFile.parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(first.messageText, " ");
    issues.push(`${item.path} has a parse diagnostic: ${message}`);
  }
  return sourceFile;
}

function scanBindingPattern(
  pattern,
  baseKind,
  bindings,
  reportTransport,
  reportUnresolved,
  reportAmbiguous,
) {
  if (baseKind === AMBIGUOUS_BROWSER_PROVENANCE) {
    reportAmbiguous();
    return;
  }
  if (!ts.isObjectBindingPattern(pattern)) return;
  for (const element of pattern.elements) {
    if (element.dotDotDotToken !== undefined) {
      reportUnresolved();
      continue;
    }
    const propertyName = staticPropertyName(
      element.propertyName ?? element.name,
      bindings,
    );
    if (propertyName === undefined) {
      reportUnresolved();
      continue;
    }
    const nestedKind = browserPropertyKind(baseKind, propertyName);
    const transport = transportAtKind(nestedKind);
    if (transport !== undefined) reportTransport(transport);
    if (nestedKind !== undefined) {
      scanBindingPattern(
        element.name,
        nestedKind,
        bindings,
        reportTransport,
        reportUnresolved,
        reportAmbiguous,
      );
    }
  }
}

function scanAssignmentPattern(
  pattern,
  baseKind,
  bindings,
  reportTransport,
  reportUnresolved,
  reportAmbiguous,
) {
  if (baseKind === AMBIGUOUS_BROWSER_PROVENANCE) {
    reportAmbiguous();
    return;
  }
  if (!ts.isObjectLiteralExpression(pattern)) return;
  for (const property of pattern.properties) {
    if (ts.isSpreadAssignment(property)) {
      reportUnresolved();
      continue;
    }
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      continue;
    }
    const propertyName = staticPropertyName(property.name, bindings);
    if (propertyName === undefined) {
      reportUnresolved();
      continue;
    }
    const nestedKind = browserPropertyKind(baseKind, propertyName);
    const transport = transportAtKind(nestedKind);
    if (transport !== undefined) reportTransport(transport);
    if (
      nestedKind !== undefined &&
      ts.isPropertyAssignment(property) &&
      ts.isObjectLiteralExpression(unwrapExpression(property.initializer))
    ) {
      scanAssignmentPattern(
        unwrapExpression(property.initializer),
        nestedKind,
        bindings,
        reportTransport,
        reportUnresolved,
        reportAmbiguous,
      );
    }
  }
}

function scanBrowserSource(issues, item, sourceFile) {
  // This is deliberately a bounded static guard: it rejects constant external
  // endpoints at the enumerated executable sinks and direct prohibited browser
  // primitives. Dynamic browser network accounting remains a separate gate.
  const bindings = collectBindings(sourceFile);
  const reportedTransports = new Set();
  const reportedRoots = new Set();
  let reportedEndpoint = false;
  let reportedUnresolved = false;
  let reportedAmbiguous = false;
  let reportedUnsupportedStorage = false;

  function reportTransport(transport) {
    if (reportedTransports.has(transport)) return;
    reportedTransports.add(transport);
    issues.push(
      `${item.path} contains forbidden direct browser primitive ${transport}.`,
    );
  }

  function reportRoot(root) {
    if (reportedRoots.has(root)) return;
    reportedRoots.add(root);
    issues.push(
      `${item.path} contains unsupported direct browser root ${root}.`,
    );
  }

  function reportUnresolved() {
    if (reportedUnresolved) return;
    reportedUnresolved = true;
    issues.push(
      `${item.path} contains unresolved computed access on a known browser global.`,
    );
  }

  function reportAmbiguous() {
    if (reportedAmbiguous) return;
    reportedAmbiguous = true;
    issues.push(
      `${item.path} contains ambiguous mutable browser provenance after reassignment.`,
    );
  }

  function reportUnsupportedStorage() {
    if (reportedUnsupportedStorage) return;
    reportedUnsupportedStorage = true;
    issues.push(
      `${item.path} contains unsupported property storage of known browser provenance.`,
    );
  }

  function reportStoredBrowserValue(value) {
    const storedKind = browserValueKind(value, bindings);
    if (storedKind === AMBIGUOUS_BROWSER_PROVENANCE) {
      reportAmbiguous();
    } else if (storedKind !== undefined) {
      reportUnsupportedStorage();
    }
  }

  function reportEndpoint(expression) {
    if (reportedEndpoint) return;
    const unwrapped = endpointValueExpression(expression, bindings);
    const value = staticallyKnownString(unwrapped, bindings);
    if (
      (value === undefined || !urlShapedValue(value)) &&
      !templateHasUrlShape(unwrapped)
    ) {
      return;
    }
    reportedEndpoint = true;
    issues.push(
      `${item.path} contains an executable package-owned URL-shaped value at a network or resource-loading sink.`,
    );
  }

  function reportCallEndpoint(node, calleeKind) {
    const arguments_ = node.arguments ?? [];
    const transport = transportAtKind(calleeKind);
    if (transport === "importScripts") {
      for (const argument of arguments_) reportEndpoint(argument);
      return;
    }
    if (transport !== undefined || calleeKind === "endpoint-loader") {
      if (arguments_[0] !== undefined) reportEndpoint(arguments_[0]);
      return;
    }
    if (calleeKind === "xml-http-request-open") {
      if (arguments_[1] !== undefined) reportEndpoint(arguments_[1]);
      return;
    }
    if (calleeKind === "resource-set-attribute") {
      const attribute =
        arguments_[0] === undefined
          ? undefined
          : staticallyKnownString(arguments_[0], bindings);
      if (
        attribute !== undefined &&
        RESOURCE_URL_PROPERTIES.has(attribute.toLowerCase()) &&
        arguments_[1] !== undefined
      ) {
        reportEndpoint(arguments_[1]);
      }
    }
  }

  function visit(node) {
    if (
      ts.isIdentifier(node) &&
      isRuntimeIdentifierReference(node) &&
      resolveBinding(bindings, node) === undefined
    ) {
      const transport = DIRECT_BROWSER_PRIMITIVES.get(node.text);
      if (transport !== undefined) reportTransport(transport);
      if (
        DIRECT_BROWSER_ROOT_NAMES.has(node.text) &&
        !isAllowedDirectBrowserRoot(node, item.path, bindings)
      ) {
        reportRoot(node.text);
      }
    }

    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isSpreadAssignment(node)) &&
      !isWithinDestructuringAssignmentTarget(node)
    ) {
      const value = ts.isPropertyAssignment(node)
        ? node.initializer
        : ts.isShorthandPropertyAssignment(node)
          ? node.name
          : node.expression;
      reportStoredBrowserValue(value);
    }

    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (ts.isOmittedExpression(element)) continue;
        reportStoredBrowserValue(
          ts.isSpreadElement(element) ? element.expression : element,
        );
      }
    }

    if (ts.isBindingElement(node) && node.initializer !== undefined) {
      reportStoredBrowserValue(node.initializer);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      reportTransport("dynamic import");
      if (node.arguments[0] !== undefined) reportEndpoint(node.arguments[0]);
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const calleeKind = browserValueKind(node.expression, bindings);
      if (calleeKind === AMBIGUOUS_BROWSER_PROVENANCE) {
        reportAmbiguous();
      } else {
        const transport = transportAtKind(calleeKind);
        if (transport !== undefined) reportTransport(transport);
        reportCallEndpoint(node, calleeKind);
      }
      if (
        ts.isNewExpression(node) &&
        (calleeKind === "image-constructor" ||
          calleeKind === "audio-constructor") &&
        node.arguments?.[0] !== undefined
      ) {
        reportEndpoint(node.arguments[0]);
      }

      if (calleeKind === "reflect-get" && node.arguments.length >= 2) {
        const baseKind = browserValueKind(node.arguments[0], bindings);
        if (baseKind === AMBIGUOUS_BROWSER_PROVENANCE) {
          reportAmbiguous();
        } else if (baseKind !== undefined) {
          const propertyName = staticallyKnownString(
            node.arguments[1],
            bindings,
          );
          if (propertyName === undefined) {
            reportUnresolved();
          } else {
            const reflectedKind = browserPropertyKind(baseKind, propertyName);
            const reflectedTransport = transportAtKind(reflectedKind);
            if (reflectedTransport !== undefined) {
              reportTransport(reflectedTransport);
            }
          }
        }
      }
    }

    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const baseKind = browserObjectKind(node.expression, bindings);
      if (baseKind === AMBIGUOUS_BROWSER_PROVENANCE) {
        reportAmbiguous();
      } else if (baseKind !== undefined) {
        const propertyName = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : staticallyKnownString(node.argumentExpression, bindings);
        if (propertyName === undefined) {
          reportUnresolved();
        } else {
          const transport = forbiddenProperty(baseKind, propertyName);
          if (transport !== undefined) reportTransport(transport);
        }
      }
    }

    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      node.initializer !== undefined &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const baseKind = browserObjectKind(node.initializer, bindings);
      if (baseKind !== undefined) {
        scanBindingPattern(
          node.name,
          baseKind,
          bindings,
          reportTransport,
          reportUnresolved,
          reportAmbiguous,
        );
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const left = unwrapExpression(node.left);
      const rightKind = browserValueKind(node.right, bindings);
      if (isWithinDestructuringAssignmentTarget(node)) {
        reportStoredBrowserValue(node.right);
      } else if (
        ts.isIdentifier(left) &&
        browserValueKind(left, bindings) === AMBIGUOUS_BROWSER_PROVENANCE
      ) {
        reportAmbiguous();
      } else if (
        ts.isIdentifier(left) &&
        browserValueKind(left, bindings) === "location"
      ) {
        reportEndpoint(node.right);
      } else if (rightKind === AMBIGUOUS_BROWSER_PROVENANCE) {
        reportAmbiguous();
      } else if (
        ts.isObjectLiteralExpression(left) &&
        rightKind !== undefined
      ) {
        scanAssignmentPattern(
          left,
          rightKind,
          bindings,
          reportTransport,
          reportUnresolved,
          reportAmbiguous,
        );
      } else if (
        ts.isPropertyAccessExpression(left) ||
        ts.isElementAccessExpression(left)
      ) {
        const baseKind = browserValueKind(left.expression, bindings);
        const propertyName = ts.isPropertyAccessExpression(left)
          ? left.name.text
          : staticallyKnownString(left.argumentExpression, bindings);
        if (baseKind === AMBIGUOUS_BROWSER_PROVENANCE) {
          reportAmbiguous();
        }
        if (rightKind !== undefined) {
          reportUnsupportedStorage();
        }
        const targetKind =
          baseKind === undefined || propertyName === undefined
            ? undefined
            : browserPropertyKind(baseKind, propertyName);
        if (
          baseKind === "resource-element" &&
          propertyName !== undefined &&
          RESOURCE_URL_PROPERTIES.has(propertyName.toLowerCase())
        ) {
          reportEndpoint(node.right);
        } else if (
          (baseKind === "location" && propertyName === "href") ||
          targetKind === "location"
        ) {
          reportEndpoint(node.right);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

function validateBrowserProductionSourceInventory(issues, sources, packages) {
  const inventory = Array.isArray(sources)
    ? sources
        .filter(({ path: sourcePath }) => isBrowserSourcePath(sourcePath))
        .map((item) => ({
          ...item,
          path: normalizeSourcePath(item.path),
        }))
    : [];

  for (const item of inventory) {
    if (item.isSymbolicLink === true) {
      issues.push(`${item.path} is a symbolic link inside browser source.`);
    }
  }

  const sourceByPath = new Map();
  for (const item of inventory) {
    if (!isSourceCodePath(item.path) || item.isSymbolicLink === true) continue;
    if (sourceByPath.has(item.path)) {
      issues.push(
        `${item.path} appears more than once in browser source inventory.`,
      );
    } else {
      sourceByPath.set(item.path, item);
    }
  }

  const parsedSources = new Map();
  function parsed(item) {
    let sourceFile = parsedSources.get(item.path);
    if (sourceFile === undefined) {
      sourceFile = parseBrowserSource(item, issues);
      parsedSources.set(item.path, sourceFile);
    }
    return sourceFile;
  }

  const queue = [...sourceByPath.values()]
    .filter(({ path: sourcePath }) =>
      isShippedBrowserProductionSource(sourcePath),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  const reachable = new Set();

  while (queue.length > 0) {
    const item = queue.shift();
    if (reachable.has(item.path)) continue;
    reachable.add(item.path);
    const sourceFile = parsed(item);

    for (const specifier of importSpecifiers(sourceFile)) {
      const targetPath = resolveRelativeSource(
        item.path,
        specifier,
        sourceByPath,
      );
      if (targetPath === undefined || reachable.has(targetPath)) continue;
      const target = sourceByPath.get(targetPath);
      if (target === undefined) continue;
      if (isExcludedLookingSource(targetPath)) {
        issues.push(
          `${item.path} imports excluded-looking source ${targetPath}; production source cannot import tests or fixtures.`,
        );
      }
      queue.push(target);
    }
  }

  for (const sourcePath of [...reachable].sort()) {
    const item = sourceByPath.get(sourcePath);
    if (item !== undefined) scanBrowserSource(issues, item, parsed(item));
  }

  const browserSourceCounts = {};
  for (const pkg of packages ?? []) {
    const directory = normalizeSourcePath(pkg.directory);
    if (
      directory !== "packages/core" &&
      !directory.startsWith("packages/adapters/")
    ) {
      continue;
    }
    const label = packageLabel(pkg);
    const sourcePrefix = `${directory}/src/`;
    const count = [...reachable].filter((sourcePath) =>
      sourcePath.startsWith(sourcePrefix),
    ).length;
    browserSourceCounts[label] = count;
    if (count === 0) {
      issues.push(`${label} is missing its scanned source inventory.`);
    }
  }

  return browserSourceCounts;
}

function validateBrowserProductionSources(issues, sources, packages) {
  return validateBrowserProductionSourceInventory(issues, sources, packages);
}

function validateWorkspacePackageInventory(issues, model) {
  for (const error of model.workspaceInventoryErrors ?? []) {
    issues.push(`Workspace package inventory could not be resolved: ${error}`);
  }

  for (const sourcePath of model.workspacePackageSymlinks ?? []) {
    issues.push(
      `${normalizeSourcePath(sourcePath)} is a symbolic link in the workspace package inventory.`,
    );
  }

  if (!Array.isArray(model.workspacePackageDirectories)) {
    issues.push("Workspace package inventory is missing.");
    return;
  }

  const discovered = new Set(
    model.packages.map((pkg) => normalizeSourcePath(pkg.directory)),
  );
  const authoritative = new Set(
    model.workspacePackageDirectories.map(normalizeSourcePath),
  );
  const absentFromWorkspace = [...discovered]
    .filter((directory) => !authoritative.has(directory))
    .sort();
  const absentFromDiscovery = [...authoritative]
    .filter((directory) => !discovered.has(directory))
    .sort();

  if (absentFromWorkspace.length > 0 || absentFromDiscovery.length > 0) {
    const details = [
      absentFromWorkspace.length === 0
        ? undefined
        : `not declared by pnpm: ${absentFromWorkspace.join(", ")}`,
      absentFromDiscovery.length === 0
        ? undefined
        : `not discovered on disk: ${absentFromDiscovery.join(", ")}`,
    ].filter(Boolean);
    issues.push(`Workspace package inventory mismatch; ${details.join("; ")}.`);
  }
}

export class ArchitectureValidationError extends Error {
  constructor(issues) {
    super(
      `Architecture verification failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
    );
    this.name = "ArchitectureValidationError";
    this.issues = issues;
  }
}

function packageLabel(pkg) {
  return pkg.manifest.name ?? pkg.directory;
}

function parseExactBytes(limit) {
  const match = String(limit)
    .trim()
    .match(/^(\d+)\s*B$/);
  return match ? Number(match[1]) : Number.NaN;
}

function validateRules(issues, cruiseConfig) {
  const rules = new Map(
    (cruiseConfig?.forbidden ?? []).map((rule) => [rule.name, rule]),
  );

  for (const name of REQUIRED_RULES) {
    const rule = rules.get(name);
    if (!rule) {
      issues.push(`Architecture rule ${name} is missing.`);
    } else if (rule.severity !== "error") {
      issues.push(`Architecture rule ${name} must use severity error.`);
    }
  }

  if (cruiseConfig?.options?.tsPreCompilationDeps !== true) {
    issues.push(
      "dependency-cruiser must enable tsPreCompilationDeps so type-only imports are checked.",
    );
  }

  return rules.size;
}

function validatePackage(issues, pkg) {
  const label = packageLabel(pkg);

  if (!pkg.hasTsconfig) issues.push(`${label} is missing tsconfig.json.`);
  if (!pkg.hasApiExtractorConfig)
    issues.push(`${label} is missing an API Extractor config.`);
  if (!pkg.hasApiReport)
    issues.push(`${label} is missing a committed API report.`);

  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(pkg.manifest[field] ?? {})) {
      if (
        name.startsWith("@opencookie-dev/") &&
        !String(range).startsWith("workspace:")
      ) {
        issues.push(
          `${label} must use the workspace protocol for internal dependency ${name}.`,
        );
      }

      if (
        pkg.directory.startsWith("packages/adapters/") &&
        name.startsWith("@opencookie-dev/") &&
        name !== "@opencookie-dev/core" &&
        !FRAMEWORK_WRAPPER_DEPENDENCIES.get(pkg.manifest.name)?.has(name)
      ) {
        issues.push(`${label} adapter cannot depend on peer adapter ${name}.`);
      }
    }
  }

  if (pkg.manifest.name === "@opencookie-dev/core") {
    const runtimeNames = RUNTIME_DEPENDENCY_FIELDS.flatMap((field) =>
      Object.keys(pkg.manifest[field] ?? {}),
    );
    if (runtimeNames.length > 0) {
      issues.push(
        `@opencookie-dev/core must keep zero runtime dependencies; found ${runtimeNames.join(", ")}.`,
      );
    }
  }
}

function validateBudgets(issues, sizeConfig) {
  const entries = new Map(
    (sizeConfig ?? []).map((entry) => [entry.name, entry]),
  );

  for (const [name, expectation] of BUDGETS) {
    const entry = entries.get(name);
    if (!entry) {
      issues.push(
        `${expectation.packageName} is missing its ${expectation.exactBytes} byte size budget.`,
      );
      continue;
    }

    const limit = parseExactBytes(entry.limit);
    if (!Number.isFinite(limit) || limit !== expectation.exactBytes) {
      issues.push(
        `${expectation.packageName} budget must be exactly ${expectation.exactBytes} bytes.`,
      );
    }
    if (expectation.compression === "gzip" && entry.gzip !== true) {
      issues.push(
        `${expectation.packageName} budget must measure gzip output.`,
      );
    }
    if (
      expectation.compression === "none" &&
      (entry.gzip === true || entry.brotli !== false)
    ) {
      issues.push(
        `${expectation.packageName} budget must measure output without compression.`,
      );
    }
    if (entry.path !== expectation.expectedPath) {
      issues.push(
        `${expectation.packageName} budget must target ${expectation.expectedPath}.`,
      );
    }
  }

  return entries.size;
}

function validateCoreBoundary(issues, pkg, sizeConfig) {
  const packageExports = pkg.manifest.exports ?? {};
  const exportNames = Object.keys(packageExports).sort();
  const expectedExportNames = [...CORE_EXPORTS.keys()].sort();

  for (const exportName of expectedExportNames) {
    if (!Object.hasOwn(packageExports, exportName)) {
      issues.push(
        `@opencookie-dev/core is missing public export ${exportName}.`,
      );
    }
  }

  for (const exportName of exportNames) {
    if (exportName === "./low-level") {
      issues.push("@opencookie-dev/core/low-level must not be exported.");
    } else if (!CORE_EXPORTS.has(exportName)) {
      issues.push(`@opencookie-dev/core export ${exportName} is not approved.`);
    }

    const outputPath = packageExports[exportName]?.import?.default;
    if (typeof outputPath !== "string" || !outputPath.endsWith(".js")) {
      continue;
    }
    const budgetPath = `packages/core/${outputPath.replace(/^\.\//u, "")}`;
    if (!(sizeConfig ?? []).some((entry) => entry.path === budgetPath)) {
      const publicName =
        exportName === "."
          ? "@opencookie-dev/core"
          : `@opencookie-dev/core/${exportName.slice(2)}`;
      issues.push(
        `${publicName} public JavaScript entry is missing a size budget.`,
      );
    }
  }

  for (const [exportName, expectedPath] of CORE_EXPORTS) {
    const actualPath = packageExports[exportName]?.import?.default;
    const normalizedPath =
      typeof actualPath === "string"
        ? `packages/core/${actualPath.replace(/^\.\//u, "")}`
        : undefined;
    if (normalizedPath !== expectedPath) {
      issues.push(
        `@opencookie-dev/core export ${exportName} must target ${expectedPath}.`,
      );
    }
  }

  for (const configName of CORE_API_CONFIGS) {
    if (!pkg.apiExtractorConfigNames?.includes(configName)) {
      issues.push(`@opencookie-dev/core is missing ${configName}.`);
    }
  }
  for (const reportName of CORE_API_REPORTS) {
    if (!pkg.apiReportNames?.includes(reportName)) {
      issues.push(`@opencookie-dev/core is missing ${reportName}.`);
    }
  }
}

export function validateArchitectureModel(model) {
  const issues = [];
  const ruleCount = validateRules(issues, model.cruiseConfig);

  validateWorkspacePackageInventory(issues, model);

  const browserSourceCounts = validateBrowserProductionSources(
    issues,
    model.browserProductionSources,
    model.packages,
  );

  for (const pkg of model.packages) validatePackage(issues, pkg);

  const corePackage = model.packages.find(
    (pkg) => pkg.manifest.name === "@opencookie-dev/core",
  );
  if (corePackage !== undefined) {
    validateCoreBoundary(issues, corePackage, model.sizeConfig);
  }

  const sizeBudgetCount = validateBudgets(issues, model.sizeConfig);
  const apiReportCount = model.packages.reduce(
    (count, pkg) =>
      count +
      (pkg.apiReportNames?.length ?? (pkg.hasApiReport === true ? 1 : 0)),
    0,
  );

  if (issues.length > 0) throw new ArchitectureValidationError(issues);

  return {
    packageCount: model.packages.length,
    ruleCount,
    apiReportCount,
    sizeBudgetCount,
    browserSourceCounts,
  };
}
