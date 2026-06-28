import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/**
 * Finds the workspace root directory by walking up from process.cwd()
 * and checking for root-specific markers (e.g., package.json with workspaces).
 */
export function findWorkspaceRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        // The root package.json has a "workspaces" field
        if (pkg.workspaces) {
          return dir;
        }
      } catch {
        // ignore JSON parsing errors
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Resolves a path relative to the workspace root directory.
 */
export function resolveWorkspacePath(...paths: string[]): string {
  return resolve(findWorkspaceRoot(), ...paths);
}
