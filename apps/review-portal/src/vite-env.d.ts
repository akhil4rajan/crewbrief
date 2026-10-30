/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_GATEWAY_URL?: string;
  readonly VITE_AUTH_MODE?: string;
  readonly VITE_ENTRA_CLIENT_ID?: string;
  readonly VITE_ENTRA_AUTHORITY?: string;
  readonly VITE_ENTRA_SCOPES?: string;
  readonly VITE_ORG_NAME?: string;
  readonly VITE_FORM_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
