const DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];

const PUBLICATION_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

export class PackageVerificationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PackageVerificationError";
  }
}

export function assertLoopbackRegistryUrl(value) {
  if (
    typeof value !== "string" ||
    !/^http:\/\/127\.0\.0\.1:[0-9]+\/$/u.test(value)
  ) {
    throw new PackageVerificationError(
      "Package verification requires a literal loopback registry URL such as http://127.0.0.1:4873/.",
    );
  }

  let registryUrl;
  try {
    registryUrl = new URL(value);
  } catch (error) {
    throw new PackageVerificationError(
      "Package verification requires a valid literal loopback registry URL.",
      { cause: error },
    );
  }

  const port = Number.parseInt(registryUrl.port, 10);
  if (
    registryUrl.protocol !== "http:" ||
    registryUrl.hostname !== "127.0.0.1" ||
    registryUrl.pathname !== "/" ||
    registryUrl.username !== "" ||
    registryUrl.password !== "" ||
    registryUrl.search !== "" ||
    registryUrl.hash !== "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new PackageVerificationError(
      "Package verification requires a literal loopback registry URL without credentials, paths, queries, or fragments.",
    );
  }

  return registryUrl.href;
}

export function validateVerdaccioConfiguration(configuration) {
  if (!isPlainObject(configuration)) {
    throw new PackageVerificationError(
      "The package-verification Verdaccio configuration must be an object.",
    );
  }

  if (Object.hasOwn(configuration, "auth")) {
    throw new PackageVerificationError(
      "The package-verification Verdaccio configuration must not define authentication.",
    );
  }

  const uplink = configuration.uplinks?.npmjs;
  if (
    !isPlainObject(configuration.uplinks) ||
    JSON.stringify(Object.keys(configuration.uplinks)) !==
      JSON.stringify(["npmjs"]) ||
    !isPlainObject(uplink) ||
    JSON.stringify(Object.keys(uplink).sort()) !==
      JSON.stringify(["cache", "url"]) ||
    uplink.url !== "https://registry.npmjs.org/" ||
    uplink.cache !== false
  ) {
    throw new PackageVerificationError(
      "The package-verification Verdaccio configuration must define only the official npm registry uplink with tarball caching disabled.",
    );
  }

  if (typeof configuration.listen !== "string") {
    throw new PackageVerificationError(
      "The package-verification Verdaccio configuration must define a loopback listen address.",
    );
  }
  assertLoopbackRegistryUrl(`http://${configuration.listen}/`);

  if (configuration.storage !== "./storage") {
    throw new PackageVerificationError(
      'The package-verification Verdaccio storage must be exactly "./storage".',
    );
  }

  if (configuration.web?.enable !== false) {
    throw new PackageVerificationError(
      "The package-verification Verdaccio web interface must be disabled.",
    );
  }

  const requiredRules = ["@opencookie-dev/*", "opencookie", "@*/*", "**"];
  if (!isPlainObject(configuration.packages)) {
    throw new PackageVerificationError(
      "The package-verification Verdaccio configuration must define package rules.",
    );
  }
  if (
    JSON.stringify(Object.keys(configuration.packages)) !==
    JSON.stringify(requiredRules)
  ) {
    throw new PackageVerificationError(
      "The package-verification Verdaccio configuration must define the ordered package rules @opencookie-dev/*, opencookie, @*/*, and **.",
    );
  }

  for (const ruleName of ["@*/*", "**"]) {
    const rule = configuration.packages[ruleName];
    if (
      !isPlainObject(rule) ||
      rule.access !== "$all" ||
      rule.publish !== "$all" ||
      rule.proxy !== "npmjs"
    ) {
      throw new PackageVerificationError(
        `Verdaccio package rule ${ruleName} must allow local access and publishing while proxying external reads through npmjs.`,
      );
    }
  }

  for (const ruleName of ["@opencookie-dev/*", "opencookie"]) {
    const localRule = configuration.packages[ruleName];
    if (
      !isPlainObject(localRule) ||
      localRule.access !== "$all" ||
      localRule.publish !== "$all" ||
      Object.hasOwn(localRule, "proxy")
    ) {
      throw new PackageVerificationError(
        `Verdaccio package rule ${ruleName} must allow local access and publishing and must never proxy.`,
      );
    }
  }

  if (configuration.middlewares?.audit?.enabled !== false) {
    throw new PackageVerificationError(
      "The package-verification Verdaccio audit middleware must be disabled.",
    );
  }

  return {
    listen: configuration.listen,
    packageRules: requiredRules,
    storage: configuration.storage,
    uplink: uplink.url,
  };
}

export function rewriteWorkspaceDependencies(manifest, publishedVersions) {
  if (!isPlainObject(manifest)) {
    throw new PackageVerificationError("A package manifest must be an object.");
  }
  if (!(publishedVersions instanceof Map)) {
    throw new PackageVerificationError(
      "Published package versions must be supplied as a Map.",
    );
  }

  const rewrittenManifest = structuredClone(manifest);

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = rewrittenManifest[field];
    if (dependencies === undefined) {
      continue;
    }
    if (!isPlainObject(dependencies)) {
      throw new PackageVerificationError(
        `Package manifest field ${field} must be an object.`,
      );
    }

    for (const [dependencyName, range] of Object.entries(dependencies)) {
      if (typeof range !== "string" || !range.startsWith("workspace:")) {
        continue;
      }

      const publishedVersion = publishedVersions.get(dependencyName);
      if (publishedVersion === undefined) {
        throw new PackageVerificationError(
          `Workspace dependency ${dependencyName} is missing a published version.`,
        );
      }

      const workspaceRange = range.slice("workspace:".length);
      if (workspaceRange === "^" || workspaceRange === "~") {
        dependencies[dependencyName] = `${workspaceRange}${publishedVersion}`;
      } else if (workspaceRange === "" || workspaceRange === "*") {
        dependencies[dependencyName] = publishedVersion;
      } else {
        dependencies[dependencyName] = workspaceRange;
      }
    }
  }

  return rewrittenManifest;
}

export function validatePackageModuleFormatContract(manifest) {
  if (!isPlainObject(manifest)) {
    throw new PackageVerificationError("A package manifest must be an object.");
  }

  const packageExports = manifest.exports;
  if (!isPlainObject(packageExports) || manifest.type !== "module") {
    return;
  }

  const exportEntries = Object.keys(packageExports).some((key) =>
    key.startsWith("."),
  )
    ? Object.entries(packageExports)
    : [[".", packageExports]];

  for (const [subpath, conditions] of exportEntries) {
    if (
      isPlainObject(conditions) &&
      Object.hasOwn(conditions, "import") &&
      !Object.hasOwn(conditions, "require") &&
      Object.hasOwn(conditions, "default")
    ) {
      throw new PackageVerificationError(
        `ESM-only export ${manifest.name ?? "<unnamed>"}${subpath === "." ? "" : subpath.slice(1)} must not define a default fallback that CommonJS require can select.`,
      );
    }
  }
}

export function attwProfileForManifest(manifest) {
  if (!isPlainObject(manifest)) {
    throw new PackageVerificationError("A package manifest must be an object.");
  }

  const rootExport = manifest.exports?.["."] ?? manifest.exports;
  const supportsRequire =
    (isPlainObject(rootExport) && Object.hasOwn(rootExport, "require")) ||
    (typeof manifest.main === "string" && manifest.main.endsWith(".cjs"));

  return supportsRequire ? "node16" : "esm-only";
}

export function sortPackagesForPublication(packages) {
  if (!Array.isArray(packages)) {
    throw new PackageVerificationError(
      "Packages must be supplied as an array.",
    );
  }

  const packageByName = new Map();
  for (const packageRecord of packages) {
    const name = packageRecord?.manifest?.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new PackageVerificationError(
        "Every public package must have a non-empty name.",
      );
    }
    if (packageByName.has(name)) {
      throw new PackageVerificationError(
        `Duplicate public package name: ${name}.`,
      );
    }
    packageByName.set(name, packageRecord);
  }

  const dependenciesByName = new Map();
  const dependantsByName = new Map(
    [...packageByName.keys()].map((name) => [name, new Set()]),
  );

  for (const [name, packageRecord] of packageByName) {
    const internalDependencies = new Set();
    for (const field of PUBLICATION_DEPENDENCY_FIELDS) {
      const dependencies = packageRecord.manifest[field];
      if (!isPlainObject(dependencies)) {
        continue;
      }
      for (const dependencyName of Object.keys(dependencies)) {
        if (packageByName.has(dependencyName) && dependencyName !== name) {
          internalDependencies.add(dependencyName);
          dependantsByName.get(dependencyName).add(name);
        }
      }
    }
    dependenciesByName.set(name, internalDependencies);
  }

  const ready = [...dependenciesByName]
    .filter(([, dependencies]) => dependencies.size === 0)
    .map(([name]) => name)
    .sort();
  const sortedPackages = [];

  while (ready.length > 0) {
    const name = ready.shift();
    sortedPackages.push(packageByName.get(name));

    for (const dependantName of [...dependantsByName.get(name)].sort()) {
      const dependencies = dependenciesByName.get(dependantName);
      dependencies.delete(name);
      if (dependencies.size === 0) {
        insertSorted(ready, dependantName);
      }
    }
  }

  if (sortedPackages.length !== packages.length) {
    const cycleNames = [...dependenciesByName]
      .filter(([, dependencies]) => dependencies.size > 0)
      .map(([name]) => name)
      .sort();
    throw new PackageVerificationError(
      `Internal package dependency cycle detected: ${cycleNames.join(", ")}.`,
    );
  }

  return sortedPackages;
}

export async function withDisposableRegistry(startRegistry, task) {
  const registry = await startRegistry();
  if (typeof registry?.stop !== "function") {
    throw new PackageVerificationError(
      "A disposable registry must provide an asynchronous stop function.",
    );
  }

  try {
    const registryUrl = assertLoopbackRegistryUrl(registry.url);
    return await task({ ...registry, url: registryUrl });
  } finally {
    await registry.stop();
  }
}

export async function usingTemporaryDirectory(resources, task) {
  if (
    typeof resources?.create !== "function" ||
    typeof resources?.remove !== "function"
  ) {
    throw new PackageVerificationError(
      "Temporary directory resources must provide create and remove functions.",
    );
  }

  const directory = await resources.create();
  try {
    return await task(directory);
  } finally {
    await resources.remove(directory);
  }
}

function insertSorted(values, value) {
  const insertionIndex = values.findIndex((candidate) => candidate > value);
  if (insertionIndex === -1) {
    values.push(value);
  } else {
    values.splice(insertionIndex, 0, value);
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
