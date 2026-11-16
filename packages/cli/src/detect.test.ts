import { describe, expect, it } from "vitest";

import {
  CliDetectionError,
  detectFramework,
  detectPackageManager,
  type FileSystemPort,
} from "./index.js";

function memoryFileSystem(
  files: Readonly<Record<string, string>>,
): FileSystemPort {
  return {
    exists: (path) => Promise.resolve(Object.hasOwn(files, path)),
    mkdir: () => Promise.resolve(),
    readFile: (path) => {
      const value = files[path];
      if (value === undefined) throw new Error(`Missing test file: ${path}`);
      return Promise.resolve(value);
    },
    replaceFile: () => Promise.resolve(),
    withLock: (_path, operation) => operation(),
    writeFile: () => Promise.resolve(),
  };
}

function packageJson(
  dependencies: Readonly<Record<string, string>>,
  packageManager?: string,
): string {
  return JSON.stringify({ dependencies, packageManager });
}

describe("detectPackageManager", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ] as const)("maps %s to %s", async (lockfile, expected) => {
    const fs = memoryFileSystem({ [lockfile]: "" });
    await expect(detectPackageManager(fs, "/app")).resolves.toBe(expected);
  });

  it("uses the packageManager declaration to resolve multiple lockfiles", async () => {
    const fs = memoryFileSystem({
      "package.json": packageJson({}, "pnpm@11.22.0"),
      "package-lock.json": "{}",
      "pnpm-lock.yaml": "",
    });
    await expect(detectPackageManager(fs, "/app")).resolves.toBe("pnpm");
  });

  it("refuses ambiguous lockfiles and unknown packageManager declarations", async () => {
    const ambiguous = memoryFileSystem({
      "package-lock.json": "{}",
      "yarn.lock": "",
    });
    await expect(detectPackageManager(ambiguous, "/app")).rejects.toThrow(
      CliDetectionError,
    );

    const hostile = memoryFileSystem({
      "package.json": packageJson({}, "other@1.0.0"),
    });
    await expect(detectPackageManager(hostile, "/app")).rejects.toThrow(
      /unsupported packageManager/i,
    );

    const invalidDeclaration = memoryFileSystem({
      "package.json": JSON.stringify({ packageManager: 42 }),
    });
    await expect(
      detectPackageManager(invalidDeclaration, "/app"),
    ).rejects.toThrow(/invalid package.json/i);
  });
});

describe("detectFramework", () => {
  it.each([
    [
      "react-vite",
      { "package.json": packageJson({ react: "latest", vite: "latest" }) },
    ],
    [
      "vue-vite",
      { "package.json": packageJson({ vue: "latest", vite: "latest" }) },
    ],
    [
      "nuxt",
      {
        "nuxt.config.ts": "",
        "package.json": packageJson({ nuxt: "4.5.2" }),
      },
    ],
    [
      "nuxt",
      {
        "nuxt.config.ts": "",
        "package.json": packageJson({ nuxt: "^4.5.2" }),
      },
    ],
    [
      "sveltekit",
      {
        "svelte.config.js": "",
        "package.json": packageJson({ "@sveltejs/kit": "latest" }),
      },
    ],
    [
      "astro",
      {
        "astro.config.mjs": "",
        "package.json": packageJson({ astro: "latest" }),
      },
    ],
    ["plain-html", { "index.html": "<!doctype html>" }],
  ] as const)("detects %s", async (expected, files) => {
    await expect(
      detectFramework(memoryFileSystem(files), "/app"),
    ).resolves.toBe(expected);
  });

  it("distinguishes Next App and Pages routers, including src layouts", async () => {
    const manifest = packageJson({ next: "latest", react: "latest" });
    await expect(
      detectFramework(
        memoryFileSystem({ "package.json": manifest, "src/app/page.tsx": "" }),
        "/app",
      ),
    ).resolves.toBe("next-app");
    await expect(
      detectFramework(
        memoryFileSystem({
          "package.json": manifest,
          "src/pages/index.tsx": "",
        }),
        "/app",
      ),
    ).resolves.toBe("next-pages");
  });

  it.each([
    {
      expected: "next-app",
      files: { "app/page.tsx": "", "src/app/page.tsx": "" },
      name: "App Router roots",
    },
    {
      expected: "next-pages",
      files: { "pages/index.tsx": "", "src/pages/index.tsx": "" },
      name: "Pages Router roots",
    },
  ] as const)(
    "prefers the active root directory over a stale src tree for $name",
    async ({ expected, files }) => {
      const manifest = packageJson({ next: "latest", react: "latest" });
      await expect(
        detectFramework(
          memoryFileSystem({ ...files, "package.json": manifest }),
          "/app",
        ),
      ).resolves.toBe(expected);
    },
  );

  it("refuses mixed routers, mixed frameworks, invalid manifests, and unsupported Nuxt majors", async () => {
    const next = packageJson({ next: "latest", react: "latest" });
    await expect(
      detectFramework(
        memoryFileSystem({
          "app/page.tsx": "",
          "package.json": next,
          "pages/index.tsx": "",
        }),
        "/app",
      ),
    ).rejects.toThrow(/both Next/i);

    await expect(
      detectFramework(
        memoryFileSystem({
          "package.json": packageJson({ astro: "latest", nuxt: "^3.0.0" }),
        }),
        "/app",
      ),
    ).rejects.toThrow(/multiple frameworks/i);

    await expect(
      detectFramework(memoryFileSystem({ "package.json": "{" }), "/app"),
    ).rejects.toThrow(/invalid package.json/i);

    await expect(
      detectFramework(
        memoryFileSystem({
          "package.json": JSON.stringify({ dependencies: ["react", "vite"] }),
        }),
        "/app",
      ),
    ).rejects.toThrow(/invalid package.json/i);

    await expect(
      detectFramework(
        memoryFileSystem({
          "nuxt.config.ts": "",
          "package.json": packageJson({ nuxt: "^5.0.0" }),
        }),
        "/app",
      ),
    ).rejects.toThrow(/supports Nuxt 4/i);

    for (const version of ["^3.21.11", "5.0.1", "latest", "npm:nuxt@^4.3.0"]) {
      await expect(
        detectFramework(
          memoryFileSystem({
            "nuxt.config.ts": "",
            "package.json": packageJson({ nuxt: version }),
          }),
          "/app",
        ),
      ).rejects.toThrow(/supports Nuxt 4/i);
    }
  });

  it.each(["^3.21.11 || ^4.5.2", ">=3 <5", "4.5.2 - 5.0.0"])(
    "refuses Nuxt ranges that are not entirely within major 4: %s",
    async (version) => {
      await expect(
        detectFramework(
          memoryFileSystem({
            "nuxt.config.ts": "",
            "package.json": packageJson({ nuxt: version }),
          }),
          "/app",
        ),
      ).rejects.toThrow(/supports Nuxt 4/i);
    },
  );

  it.each(["^4.5.2 || ~4.6.0", ">=4.0.0 <5.0.0", "4.5.2 - 4.99.99"])(
    "accepts Nuxt ranges entirely within major 4: %s",
    async (version) => {
      await expect(
        detectFramework(
          memoryFileSystem({
            "nuxt.config.ts": "",
            "package.json": packageJson({ nuxt: version }),
          }),
          "/app",
        ),
      ).resolves.toBe("nuxt");
    },
  );
});
