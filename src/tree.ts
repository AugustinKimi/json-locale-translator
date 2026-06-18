/**
 * Structure-preserving JSON tree utilities.
 *
 * Unlike the legacy flatten/unflatten model, these helpers walk the JSON tree
 * directly so that arrays stay arrays, numeric-keyed objects stay objects, and
 * non-string leaves (numbers, booleans, null) round-trip untouched. Only string
 * leaves are extracted for translation; everything else is preserved verbatim
 * via a deep clone of the source structure.
 */

/** A path into a JSON tree. String segments are object keys; numbers are array indices. */
export type TreePath = Array<string | number>;

export interface StringLeaf {
  /** Structural path used to write the translation back into the cloned tree. */
  path: TreePath;
  /** Dotted representation of `path`, e.g. `home.sections.0.title`. */
  pathKey: string;
  /** The source string at this path. */
  value: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Join a structural path into a dotted key (array indices become numeric segments). */
export function pathToKey(path: TreePath): string {
  return path.join(".");
}

/**
 * Walk a JSON value and collect every translatable string leaf.
 *
 * Empty and whitespace-only strings are skipped — they are never sent to the
 * API and are left untouched in the output (they remain in the deep clone).
 */
export function collectStringLeaves(root: unknown): StringLeaf[] {
  const out: StringLeaf[] = [];
  const walk = (node: unknown, path: TreePath): void => {
    if (typeof node === "string") {
      if (node.trim() !== "") {
        out.push({ path: [...path], pathKey: pathToKey(path), value: node });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, [...path, i]));
      return;
    }
    if (isPlainObject(node)) {
      for (const [key, value] of Object.entries(node)) {
        walk(value, [...path, key]);
      }
    }
    // numbers, booleans, null: not translatable — preserved by deepClone.
  };
  walk(root, []);
  return out;
}

/**
 * Deep clone a JSON-compatible value, preserving arrays, object key order, and
 * primitive values (numbers/booleans/null/empty strings included).
 */
export function deepClone<T>(node: T): T {
  if (Array.isArray(node)) {
    return node.map((item) => deepClone(item)) as unknown as T;
  }
  if (isPlainObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = deepClone(value);
    }
    return out as unknown as T;
  }
  return node;
}

/** Read the value at `path`, or `undefined` if any segment is missing/mistyped. */
export function getAtPath(root: unknown, path: TreePath): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (Array.isArray(cur)) {
      if (typeof seg !== "number") return undefined;
      cur = cur[seg];
    } else if (isPlainObject(cur)) {
      cur = cur[String(seg)];
    } else {
      return undefined;
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * Set a string value at `path` inside a mutable tree. The path is expected to
 * already exist structurally (it always does for leaves collected from the
 * source clone).
 */
export function setAtPath(root: unknown, path: TreePath, value: string): void {
  if (path.length === 0) return;
  let cur = root as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    cur = cur[path[i]] as Record<string | number, unknown>;
  }
  cur[path[path.length - 1]] = value;
}

/**
 * Remove keys/indices from `target` that no longer exist in `source`.
 * Mutates `target` in place. Returns a rough count of removed branches/leaves
 * (a removed subtree counts as one).
 */
export function pruneToSource(target: unknown, source: unknown): number {
  let removed = 0;
  if (Array.isArray(target) && Array.isArray(source)) {
    if (target.length > source.length) {
      removed += target.length - source.length;
      target.length = source.length;
    }
    for (let i = 0; i < target.length; i++) {
      removed += pruneToSource(target[i], source[i]);
    }
    return removed;
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    for (const key of Object.keys(target)) {
      if (!(key in source)) {
        delete target[key];
        removed++;
      } else {
        removed += pruneToSource(target[key], source[key]);
      }
    }
    return removed;
  }
  return removed;
}
