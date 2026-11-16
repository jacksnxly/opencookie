import { subset } from "semver";

import type {
  FileSystemPort,
  PackageManager,
  SupportedFramework,
} from "./contracts.js";

/** A project cannot be initialized safely because its shape is unsupported or ambiguous. @public */
export class CliDetectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliDetectionError";
  }
}

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly packageManager?: string;
}

function parseDependencies(
  value: unknown,
  field: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must contain a package-name object`);
  }
  const dependencies: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string") {
      throw new TypeError(`${field}.${name} must be a version string`);
    }
    dependencies[name] = version;
  }
  return dependencies;
}

async function readManifest(
  fileSystem: FileSystemPort,
): Promise<PackageManifest | undefined> {
  if (!(await fileSystem.exists("package.json"))) return undefined;

  try {
    const value: unknown = JSON.parse(
      await fileSystem.readFile("package.json"),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("package.json must contain an object");
    }
    const record = value as Record<string, unknown>;
    const dependencies = parseDependencies(
      record["dependencies"],
      "dependencies",
    );
    const devDependencies = parseDependencies(
      record["devDependencies"],
      "devDependencies",
    );
    const packageManager = record["packageManager"];
    if (packageManager !== undefined && typeof packageManager !== "string") {
      throw new TypeError("packageManager must be a string");
    }
    return {
      ...(dependencies === undefined ? {} : { dependencies }),
      ...(devDependencies === undefined ? {} : { devDependencies }),
      ...(packageManager === undefined ? {} : { packageManager }),
    };
  } catch (cause: unknown) {
    throw new CliDetectionError(
      `Invalid package.json. Fix it before running OpenCookie init. ${cause instanceof Error ? cause.message : ""}`.trim(),
    );
  }
}

function dependencyMap(
  manifest: PackageManifest | undefined,
): Readonly<Record<string, string>> {
  return { ...manifest?.devDependencies, ...manifest?.dependencies };
}

const packageManagerLockfiles = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
] as const satisfies readonly (readonly [string, PackageManager])[];

function declaredPackageManager(value: string): PackageManager {
  const name = value.split("@", 1)[0];
  if (name === "bun" || name === "npm" || name === "pnpm" || name === "yarn") {
    return name;
  }
  throw new CliDetectionError(
    `Unsupported packageManager declaration ${JSON.stringify(value)}. Use npm, pnpm, yarn, or bun.`,
  );
}

/** Detects the package manager without invoking it. Defaults to npm when no signal exists. @public */
export async function detectPackageManager(
  fileSystem: FileSystemPort,
  projectRoot: string,
): Promise<PackageManager> {
  const manifest = await readManifest(fileSystem);
  const observed = new Set<PackageManager>();
  for (const [lockfile, packageManager] of packageManagerLockfiles) {
    if (await fileSystem.exists(lockfile)) observed.add(packageManager);
  }

  if (manifest?.packageManager !== undefined) {
    const declared = declaredPackageManager(manifest.packageManager);
    if (observed.size > 0 && !observed.has(declared)) {
      throw new CliDetectionError(
        `packageManager declares ${declared}, but ${projectRoot} contains a different package manager lockfile.`,
      );
    }
    return declared;
  }

  if (observed.size > 1) {
    throw new CliDetectionError(
      `Multiple package manager lockfiles were found in ${projectRoot}. Remove stale lockfiles or declare packageManager explicitly.`,
    );
  }
  return observed.values().next().value ?? "npm";
}

async function anyExists(
  fileSystem: FileSystemPort,
  candidates: readonly string[],
): Promise<boolean> {
  for (const candidate of candidates) {
    if (await fileSystem.exists(candidate)) return true;
  }
  return false;
}

function targetsSupportedNuxt(version: string): boolean {
  try {
    return subset(version, ">=4.0.0 <5.0.0");
  } catch {
    return false;
  }
}

/** Detects one supported framework and refuses ambiguous or unsupported shapes. @public */
export async function detectFramework(
  fileSystem: FileSystemPort,
  projectRoot: string,
): Promise<SupportedFramework> {
  const manifest = await readManifest(fileSystem);
  const dependencies = dependencyMap(manifest);
  const candidates: SupportedFramework[] = [];

  if (dependencies["next"] !== undefined) candidates.push("next-app");
  if (dependencies["nuxt"] !== undefined) candidates.push("nuxt");
  if (dependencies["@sveltejs/kit"] !== undefined) candidates.push("sveltekit");
  if (dependencies["astro"] !== undefined) candidates.push("astro");
  if (
    dependencies["vite"] !== undefined &&
    dependencies["react"] !== undefined
  ) {
    candidates.push("react-vite");
  }
  if (dependencies["vite"] !== undefined && dependencies["vue"] !== undefined) {
    candidates.push("vue-vite");
  }

  if (candidates.length > 1) {
    throw new CliDetectionError(
      `Multiple frameworks were detected in ${projectRoot}: ${candidates.join(", ")}. Run init from a single application root.`,
    );
  }

  const candidate = candidates[0];
  if (candidate === "next-app") {
    const [
      hasRootAppDirectory,
      hasSrcAppDirectory,
      hasRootPagesDirectory,
      hasSrcPagesDirectory,
      hasRootAppEntrypoint,
      hasSrcAppEntrypoint,
      hasRootPagesEntrypoint,
      hasSrcPagesEntrypoint,
    ] = await Promise.all([
      fileSystem.exists("app"),
      fileSystem.exists("src/app"),
      fileSystem.exists("pages"),
      fileSystem.exists("src/pages"),
      anyExists(fileSystem, [
        "app/page.js",
        "app/page.jsx",
        "app/page.ts",
        "app/page.tsx",
      ]),
      anyExists(fileSystem, [
        "src/app/page.js",
        "src/app/page.jsx",
        "src/app/page.ts",
        "src/app/page.tsx",
      ]),
      anyExists(fileSystem, [
        "pages/_app.js",
        "pages/_app.jsx",
        "pages/_app.ts",
        "pages/_app.tsx",
        "pages/index.js",
        "pages/index.jsx",
        "pages/index.ts",
        "pages/index.tsx",
      ]),
      anyExists(fileSystem, [
        "src/pages/_app.js",
        "src/pages/_app.jsx",
        "src/pages/_app.ts",
        "src/pages/_app.tsx",
        "src/pages/index.js",
        "src/pages/index.jsx",
        "src/pages/index.ts",
        "src/pages/index.tsx",
      ]),
    ]);
    const hasRootAppRouter = hasRootAppDirectory || hasRootAppEntrypoint;
    const hasSrcAppRouter = hasSrcAppDirectory || hasSrcAppEntrypoint;
    const hasRootPagesRouter = hasRootPagesDirectory || hasRootPagesEntrypoint;
    const hasSrcPagesRouter = hasSrcPagesDirectory || hasSrcPagesEntrypoint;
    const hasAppRouter = hasRootAppRouter || hasSrcAppRouter;
    const hasPagesRouter = hasRootPagesRouter || hasSrcPagesRouter;
    if (hasAppRouter && hasPagesRouter) {
      throw new CliDetectionError(
        "Both Next.js App Router and Pages Router entrypoints were found. Choose one router before initialization.",
      );
    }
    if (hasAppRouter) return "next-app";
    if (hasPagesRouter) return "next-pages";
    throw new CliDetectionError(
      "Next.js is installed, but no App Router or Pages Router entrypoint was found.",
    );
  }

  if (candidate === "nuxt") {
    if (!targetsSupportedNuxt(dependencies["nuxt"] ?? "")) {
      throw new CliDetectionError(
        "The OpenCookie Nuxt adapter supports Nuxt 4. Nuxt 3 reached end of life on 2026-07-31; upgrade the application to Nuxt 4, or choose another adapter.",
      );
    }
    return candidate;
  }

  if (candidate !== undefined) return candidate;
  if (await fileSystem.exists("index.html")) return "plain-html";

  throw new CliDetectionError(
    `No supported framework was detected in ${projectRoot}.`,
  );
}
