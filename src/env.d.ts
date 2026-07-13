declare module '*.css';

interface ImportMetaEnv {
  readonly VITE_COOP_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
