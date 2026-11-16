// Ambient declarations for the node builtins the auto contract tests use.
// Core sources compile platform-neutral without a node type library, and
// dependency-cruiser keeps node builtins out of every non-test source module.
declare module "node:fs" {
  export function existsSync(path: URL | string): boolean;
  export function readFileSync(path: URL | string, encoding: "utf8"): string;
}
