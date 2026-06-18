import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { writeJsonFile } from "./json-utils.js";
import { join } from "node:path";

/**
 * Human-readable, optionally path-aware translation cache.
 *
 * On-disk format (`<cacheDir>/<locale>.json`):
 *
 *   {
 *     "_model": "gpt-4o",
 *     "entries": { "<cache-key>": "<translation>" }
 *   }
 *
 * The cache key depends on `cacheKeying`:
 *   - 'source' (default): the source string — identical strings dedupe app-wide.
 *   - 'path':            `<relFile>#<dotted.path>` — the same source string can
 *                        have different, context-specific translations per place.
 *
 * The whole file is invalidated when `_model` differs from the configured model.
 * The legacy opaque `{ <sha256>: translation }` format is detected and ignored
 * (it cannot be migrated losslessly — it has no source strings); the user is
 * told to run `json-translate adopt` to rebuild.
 */

export type CacheKeying = "source" | "path";

export interface LoadCacheResult {
  /** key → translation map (empty when invalidated, legacy, or missing). */
  entries: Record<string, string>;
  /** Legacy hash-based format was found and ignored. */
  legacy: boolean;
  /** The cached `_model` differed from the configured model → invalidated. */
  modelChanged: boolean;
}

function cacheFilePath(cacheDir: string, locale: string): string {
  return join(cacheDir, `${locale}.json`);
}

export async function loadCache(
  cacheDir: string,
  locale: string,
  model: string,
): Promise<LoadCacheResult> {
  const filePath = cacheFilePath(cacheDir, locale);
  if (!existsSync(filePath)) {
    return { entries: {}, legacy: false, modelChanged: false };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return { entries: {}, legacy: false, modelChanged: false };
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { entries: {}, legacy: false, modelChanged: false };
  }

  const obj = raw as Record<string, unknown>;
  const hasNewShape =
    typeof obj._model === "string" &&
    obj.entries !== null &&
    typeof obj.entries === "object" &&
    !Array.isArray(obj.entries);

  if (hasNewShape) {
    if (obj._model !== model) {
      return { entries: {}, legacy: false, modelChanged: true };
    }
    return {
      entries: { ...(obj.entries as Record<string, string>) },
      legacy: false,
      modelChanged: false,
    };
  }

  // Unrecognised shape with content → assume the legacy hash format and ignore.
  const legacy = Object.keys(obj).length > 0;
  return { entries: {}, legacy, modelChanged: false };
}

export async function saveCache(
  cacheDir: string,
  locale: string,
  model: string,
  entries: Record<string, string>,
  indent = 2,
): Promise<void> {
  const data = { _model: model, entries };
  await writeJsonFile(cacheFilePath(cacheDir, locale), data, indent);
}

/** Compute the cache key for a leaf under the configured keying strategy. */
export function cacheKeyFor(
  keying: CacheKeying,
  source: string,
  relFile: string,
  pathKey: string,
): string {
  return keying === "path" ? `${relFile}#${pathKey}` : source;
}
