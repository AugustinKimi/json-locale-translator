import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

export function flattenJson(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = flattenJson(value as Record<string, unknown>, fullKey);
      Object.assign(result, nested);
    } else if (typeof value === "string") {
      result[fullKey] = value;
    }
    // Skip numbers, booleans, arrays, null
  }
  return result;
}

export function unflattenJson(
  flat: Record<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    let current: Record<string, unknown> = result;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (
        !(part in current) ||
        typeof current[part] !== "object" ||
        current[part] === null
      ) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

export async function readJsonFile(
  filePath: string,
): Promise<Record<string, unknown>> {
  if (!existsSync(filePath)) {
    return {};
  }
  const content = await readFile(filePath, "utf-8");
  return JSON.parse(content) as Record<string, unknown>;
}

export async function writeJsonFile(
  filePath: string,
  data: unknown,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function mergeJson(
  existing: Record<string, unknown>,
  translated: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(translated)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = mergeJson(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Recursively collect all .json file paths inside a directory.
 * Returns paths relative to the given root directory.
 */
export async function walkJsonFiles(
  dir: string,
  root = dir,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonFiles(full, root)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      // path.relative handles trailing slashes and separator differences correctly
      files.push(relative(root, full));
    }
  }
  return files;
}
