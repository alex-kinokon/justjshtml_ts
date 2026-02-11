import { readdir } from "node:fs/promises";
import path from "node:path";

export interface Html5libCliArgs {
  readonly testsDir: string | undefined;
  readonly testSpecs: string[];
  readonly show: boolean;
}

export const REPO_ROOT = path.resolve(import.meta.dirname, "..");

export function resolveHtml5libTestsDir(): string {
  return path.resolve(REPO_ROOT, "html5lib-tests");
}

export async function listDatFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".dat")) out.push(fullPath);
    }
  }

  await walk(dir);
  out.sort();
  return out;
}
