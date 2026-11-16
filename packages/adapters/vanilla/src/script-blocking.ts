import type {
  AccessEnforcementController,
  EnforcementOperationResult,
} from "@opencookie-dev/core/infrastructure";

import {
  documentResolver,
  enforcementResult,
  requiredIdentifier,
} from "./runtime-guards.js";
import { deleteDeclaredStorage } from "./storage-cleanup.js";

const INERT_SCRIPT_TYPE = "text/plain";

/** @public */
export interface BlockedScriptControllerOptions {
  readonly category?: string;
  readonly document?: Document;
  readonly nonce?: string;
  readonly resourceId: string;
}

/**
 * Creates an enforcement controller for one declaratively blocked script.
 * The source element remains inert. An executable clone exists only while the
 * resource is allowed, which makes repeated reconciliation deterministic.
 *
 * @public
 */
export function createBlockedScriptController(
  options: BlockedScriptControllerOptions,
): AccessEnforcementController {
  const resourceId = requiredIdentifier(
    options.resourceId,
    "Blocked script resource identifier",
  );
  const category =
    options.category === undefined
      ? undefined
      : requiredIdentifier(options.category, "Blocked script category");
  const getDocument = documentResolver(
    options.document,
    "Blocked script operations require a browser Document. Pass document when using an isolated DOM.",
  );
  const activeBySource = new WeakMap<HTMLScriptElement, HTMLScriptElement>();

  const sourceScripts = (): readonly HTMLScriptElement[] => {
    const scripts = Array.from(
      getDocument().querySelectorAll<HTMLScriptElement>(
        "script[data-oc-resource]",
      ),
    );
    return scripts.filter(
      (script) =>
        script.dataset["ocResource"] === resourceId &&
        (category === undefined || script.dataset["ocCategory"] === category),
    );
  };

  const activeScripts = (): readonly HTMLScriptElement[] =>
    Array.from(
      getDocument().querySelectorAll<HTMLScriptElement>(
        "script[data-oc-active-resource]",
      ),
    ).filter((script) => script.dataset["ocActiveResource"] === resourceId);

  const removeActiveScripts = (): void => {
    for (const script of activeScripts()) script.remove();
  };

  const activeScriptFor = (
    source: HTMLScriptElement,
  ): HTMLScriptElement | undefined => {
    const active = activeBySource.get(source);
    if (active?.isConnected === true) return active;
    activeBySource.delete(source);
    return undefined;
  };

  return Object.freeze({
    block(): Promise<EnforcementOperationResult> {
      let previousExecutionUnknown = false;
      for (const script of sourceScripts()) {
        if (script.type !== INERT_SCRIPT_TYPE) {
          previousExecutionUnknown = true;
          script.type = INERT_SCRIPT_TYPE;
        }
      }
      return Promise.resolve(
        previousExecutionUnknown
          ? enforcementResult("previous-script-execution-unknown")
          : enforcementResult(),
      );
    },

    cleanup(): Promise<EnforcementOperationResult> {
      return new Promise((resolve) => {
        removeActiveScripts();
        deleteDeclaredStorage(getDocument(), sourceScripts(), resourceId);
        resolve(enforcementResult());
      });
    },

    discover() {
      const sources = sourceScripts();
      if (sources.length === 0) return Promise.resolve("dormant" as const);
      const activeCount = sources.filter(
        (source) => activeScriptFor(source) !== undefined,
      ).length;
      if (activeCount === sources.length) {
        return Promise.resolve("active" as const);
      }
      if (activeCount > 0) return Promise.resolve("partial" as const);
      return Promise.resolve(
        sources.every((script) => script.type === INERT_SCRIPT_TYPE)
          ? ("blocked" as const)
          : ("active" as const),
      );
    },

    start(): Promise<EnforcementOperationResult> {
      const resolvedDocument = getDocument();
      let scriptStarted = false;
      for (const source of sourceScripts()) {
        if (activeScriptFor(source) !== undefined) continue;
        const executable = resolvedDocument.createElement("script");
        for (const attribute of Array.from(source.attributes)) {
          if (
            attribute.name === "src" ||
            attribute.name === "type" ||
            attribute.name === "data-src" ||
            attribute.name.startsWith("data-oc-")
          ) {
            continue;
          }
          executable.setAttribute(attribute.name, attribute.value);
        }

        executable.dataset["ocActiveResource"] = resourceId;
        const executableType = source.dataset["ocType"];
        if (executableType !== undefined && executableType.length > 0) {
          executable.type = executableType;
        }
        if (options.nonce !== undefined) executable.nonce = options.nonce;

        const sourceUrl = source.dataset["src"];
        if (sourceUrl === undefined) {
          executable.textContent = source.textContent;
        } else {
          executable.src = sourceUrl;
        }
        source.parentNode?.insertBefore(executable, source.nextSibling);
        activeBySource.set(source, executable);
        scriptStarted = true;
      }

      return Promise.resolve(
        scriptStarted
          ? enforcementResult("script-effects-may-persist")
          : enforcementResult(),
      );
    },

    stop(): Promise<void> {
      removeActiveScripts();
      return Promise.resolve();
    },
  });
}
