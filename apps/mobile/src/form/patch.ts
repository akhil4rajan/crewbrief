import type { Draft, Form, FormPatch } from "@/api/types";

/** RFC 6901 pointer → path tokens. */
function parsePointer(pointer: string): string[] {
  if (pointer === "" || pointer === "/") return [];
  if (!pointer.startsWith("/")) throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

type Container = Record<string, unknown> | unknown[];

function isContainer(v: unknown): v is Container {
  return typeof v === "object" && v !== null;
}

/**
 * Apply one patch in place. Form collections are dicts keyed by stable ids, so `add` and
 * `replace` both mean "set this key"; intermediate objects are created when missing, matching
 * what the form API does when an AI patch adds e.g. `/emergency/muster_point`.
 */
function applyOne(form: Form, patch: FormPatch): void {
  const tokens = parsePointer(patch.path);
  const last = tokens.pop();
  if (last === undefined) throw new Error("Refusing to replace the whole form");
  let node: unknown = form;
  for (const token of tokens) {
    if (!isContainer(node)) throw new Error(`Path not found: ${patch.path}`);
    const parent = node as Record<string, unknown>;
    if (!isContainer(parent[token])) {
      if (patch.op === "remove") return;
      parent[token] = {};
    }
    node = parent[token];
  }
  if (!isContainer(node)) throw new Error(`Path not found: ${patch.path}`);
  if (Array.isArray(node)) {
    const idx = last === "-" ? node.length : Number(last);
    if (patch.op === "remove") node.splice(idx, 1);
    else if (patch.op === "add") node.splice(idx, 0, patch.value);
    else node[idx] = patch.value;
    return;
  }
  if (patch.op === "remove") delete node[last];
  else node[last] = patch.value;
}

export type PatchOutcome = { kind: "applied"; draft: Draft } | { kind: "stale" } | { kind: "resync" };

/**
 * Apply a `form.patched` event to the local draft. Events carry the revision *after* the patches;
 * anything other than the next revision means we missed or duplicated an event, and the caller
 * should re-fetch GET /draft rather than guess.
 */
export function applyPatchEvent(draft: Draft, revision: number, patches: FormPatch[]): PatchOutcome {
  if (revision <= draft.revision) return { kind: "stale" };
  if (revision !== draft.revision + 1) return { kind: "resync" };
  const form = JSON.parse(JSON.stringify(draft.form)) as Form;
  try {
    for (const p of patches) applyOne(form, p);
  } catch {
    return { kind: "resync" };
  }
  return { kind: "applied", draft: { ...draft, revision, form } };
}
