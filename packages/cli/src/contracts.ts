/** Filesystem operations used by the initializer. Paths are project-relative. @public */
export interface FileSystemPort {
  readonly exists: (path: string) => Promise<boolean>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly readFile: (path: string) => Promise<string>;
  readonly replaceFile: (
    path: string,
    expectedContent: string,
    content: string,
  ) => Promise<void>;
  readonly withLock: <Result>(
    path: string,
    operation: () => Promise<Result>,
  ) => Promise<Result>;
  /**
   * Creates a file exclusively. `mode` sets its permission bits on creation,
   * so a file holding personal data can be made owner-only from the start.
   */
  readonly writeFile: (
    path: string,
    content: string,
    options?: { readonly mode?: number },
  ) => Promise<void>;
}

/** Package managers supported by OpenCookie's initializer. @public */
export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

/** Project shapes supported by OpenCookie's initializer. @public */
export type SupportedFramework =
  | "astro"
  | "next-app"
  | "next-pages"
  | "nuxt"
  | "plain-html"
  | "react-vite"
  | "sveltekit"
  | "vue-vite";
