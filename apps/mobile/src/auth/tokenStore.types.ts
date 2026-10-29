import type { User } from "@/api/types";

export interface StoredSession {
  token: string;
  user: User;
}

export interface TokenStore {
  load(): Promise<StoredSession | null>;
  save(session: StoredSession): Promise<void>;
  clear(): Promise<void>;
}
