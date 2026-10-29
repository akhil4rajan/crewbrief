import { useMemo } from "react";

import { api } from "@/api/client";
import type { User } from "@/api/types";
import { useLoad } from "./useLoad";

/** User directory for showing names (crew pickers, "signed by"). Cached per screen mount. */
export function useUsers(role?: "crew" | "supervisor") {
  const { data, error, loading } = useLoad(() => api.users(role), [role]);
  const byId = useMemo(() => new Map((data ?? []).map((u) => [u.id, u] as const)), [data]);
  const nameOf = (id: string | null | undefined): string => (id ? byId.get(id)?.name ?? id : "");
  return { users: data ?? ([] as User[]), byId, nameOf, error, loading };
}
