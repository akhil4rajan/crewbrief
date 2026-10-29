/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_GATEWAY_URL?: string;
  readonly VITE_AUTH_MODE?: string;
  readonly VITE_ENTRA_CLIENT_ID?: string;
  readonly VITE_ENTRA_AUTHORITY?: string;
  readonly VITE_ENTRA_SCOPES?: string;
  readonly VITE_SIMULATOR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
