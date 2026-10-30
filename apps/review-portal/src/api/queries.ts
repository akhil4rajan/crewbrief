import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "./endpoints";
import type { HazardLibrary, User } from "./types";

export const qk = {
  health: ["health"] as const,
  users: ["users"] as const,
  library: ["library"] as const,
  sessions: ["sessions"] as const,
  mySessions: ["sessions", "mine"] as const,
  session: (id: string) => ["session", id] as const,
  transcript: (id: string) => ["transcript", id] as const,
  audit: (id: string) => ["audit", id] as const,
  diff: (id: string) => ["diff", id] as const,
  speakers: (id: string) => ["speakers", id] as const,
};

const HOUR = 60 * 60 * 1000;

export function useHealth() {
  return useQuery({ queryKey: qk.health, queryFn: api.health, staleTime: HOUR, retry: 1 });
}

export function useUsers() {
  return useQuery({ queryKey: qk.users, queryFn: () => api.users(), staleTime: 5 * 60 * 1000 });
}

/** id → User lookup for rendering names instead of ids. */
export function useUserDirectory(): Map<string, User> {
  const { data } = useUsers();
  return useMemo(() => new Map((data ?? []).map((u) => [u.id, u])), [data]);
}

export function useLibrary() {
  return useQuery({ queryKey: qk.library, queryFn: api.library, staleTime: HOUR });
}

export interface LibraryIndex {
  library: HazardLibrary | undefined;
  taskTypeName: (code: string | null | undefined) => string;
}

export function useLibraryIndex(): LibraryIndex {
  const { data } = useLibrary();
  return useMemo(() => {
    const names = new Map((data?.task_types ?? []).map((t) => [t.code, t.name]));
    return {
      library: data,
      taskTypeName: (code) => (code ? (names.get(code) ?? code) : "—"),
    };
  }, [data]);
}
