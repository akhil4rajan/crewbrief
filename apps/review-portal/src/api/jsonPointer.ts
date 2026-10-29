import type { Draft, Form, FormPatch } from "./types";

/** RFC 6901 pointer → path segments. */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`JSON pointer must start with '/': ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
}

export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function pointer(...segments: string[]): string {
  return "/" + segments.map(escapePointerSegment).join("/");
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikeEntity(value: Json): boolean {
  return "value" in value || "code" in value || "description" in value || "type" in value;
}

/**
 * Mirrors packages.rules.engine._stamp_provenance: the form API copies the patch provenance
 * onto a node that carries none, so local application must do the same to stay identical.
 */
function stamp(value: unknown, patch: FormPatch): unknown {
  if (isObject(value) && !("provenance" in value) && looksLikeEntity(value) && patch.provenance) {
    return { ...value, provenance: patch.provenance };
  }
  return value;
}

/** Apply one patch in place on a plain JSON document (the draft form). Throws on a bad path. */
function applyOne(doc: Json, patch: FormPatch): void {
  const parts = parsePointer(patch.path);
  if (parts.length === 0) throw new Error("Cannot patch the document root");
  const key = parts[parts.length - 1];
  let parent: unknown = doc;
  for (const part of parts.slice(0, -1)) {
    parent = isObject(parent) ? parent[part] : undefined;
    if (!isObject(parent)) throw new Error(`Parent of ${patch.path} does not exist`);
  }
  const target = parent as Json;
  if (patch.op === "remove") {
    if (!(key in target)) throw new Error(`Cannot remove missing ${patch.path}`);
    delete target[key];
    return;
  }
  // As on the server, replace-on-missing is treated as add.
  target[key] = stamp(structuredClone(patch.value), patch);
}

/** Returns a new form with the patches applied, or throws if any patch does not fit. */
export function applyPatches(form: Form, patches: FormPatch[]): Form {
  const doc = structuredClone(form) as unknown as Json;
  for (const p of patches) applyOne(doc, p);
  return doc as unknown as Form;
}

/**
 * Decide whether a `form.patched` event can be applied to the cached draft.
 * The form API bumps the revision once per committed batch; we also accept one bump per patch
 * so the client stays correct whichever way the server counts. Anything else is a gap → refetch.
 */
export function classifyRevision(
  draft: Draft,
  eventRevision: number,
  patchCount: number,
): "stale" | "apply" | "gap" {
  if (eventRevision <= draft.revision) return "stale";
  if (eventRevision === draft.revision + 1 || eventRevision === draft.revision + patchCount) return "apply";
  return "gap";
}

/** Read the node at a pointer (undefined when absent). */
export function getAt(doc: unknown, path: string): unknown {
  let node: unknown = doc;
  for (const part of parsePointer(path)) {
    if (!isObject(node)) return undefined;
    node = node[part];
  }
  return node;
}
