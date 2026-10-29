import { useCallback } from "react";

import { api } from "@/api/client";
import { useLoad } from "./useLoad";

/** Hazard library (task types for pickers and display names). */
export function useLibrary() {
  const { data, error, loading } = useLoad(() => api.library(), []);
  const taskTypeName = useCallback(
    (code: string) => data?.task_types.find((t) => t.code === code)?.name ?? code,
    [data],
  );
  return { library: data, error, loading, taskTypeName };
}
