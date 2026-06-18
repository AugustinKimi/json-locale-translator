import { readJsonFile, walkJsonFiles } from "./json-utils.js";
import { collectStringLeaves, getAtPath } from "./tree.js";
import { loadCache, saveCache, cacheKeyFor } from "./cache.js";
import { basename, join } from "node:path";
import type {
  TranslatorConfig,
  AdoptResult,
  AdoptLocaleResult,
} from "./config.js";

/**
 * Bootstrap the translation cache from existing translated locale files.
 *
 * For each locale, the source tree and the existing output tree are walked in
 * parallel; for every source string leaf whose path also holds a string in the
 * target file, that (source → target) pair is written into the cache. A
 * subsequent `translate` run then only hits the API for genuinely new or
 * changed strings — no re-translation and no overwriting of good translations.
 */
export async function adopt(config: TranslatorConfig): Promise<AdoptResult> {
  const isFolder = Boolean(config.input.baseDir);
  const relativeFiles = isFolder
    ? await walkJsonFiles(config.input.baseDir!)
    : [basename(config.input.base!)];

  const results: AdoptLocaleResult[] = [];

  for (const locale of config.locales) {
    const loaded = await loadCache(
      config.options.cacheDir,
      locale,
      config.provider.model,
    );
    const entries = loaded.entries;

    let seeded = 0;
    let missing = 0;
    let orphans = 0;

    for (const rel of relativeFiles) {
      const inputPath = isFolder
        ? join(config.input.baseDir!, rel)
        : config.input.base!;
      const outputPath = isFolder
        ? join(config.output.baseDir!, locale, rel)
        : join(
            config.output.dir!,
            config.output.filename.replace("{locale}", locale),
          );

      const source = await readJsonFile(inputPath);
      const target = await readJsonFile(outputPath);

      for (const leaf of collectStringLeaves(source)) {
        const existing = getAtPath(target, leaf.path);
        if (typeof existing === "string" && existing.trim() !== "") {
          const ck = cacheKeyFor(
            config.options.cacheKeying,
            leaf.value,
            rel,
            leaf.pathKey,
          );
          entries[ck] = existing;
          seeded++;
        } else {
          missing++;
        }
      }

      // Orphans: target-only string leaves with no matching source path.
      for (const targetLeaf of collectStringLeaves(target)) {
        if (typeof getAtPath(source, targetLeaf.path) !== "string") {
          orphans++;
        }
      }
    }

    await saveCache(
      config.options.cacheDir,
      locale,
      config.provider.model,
      entries,
      config.options.indent,
    );

    results.push({
      locale,
      seeded,
      missing,
      orphans,
      filesProcessed: relativeFiles.length,
    });
  }

  return results;
}
