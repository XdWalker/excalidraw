/// <reference types="vite-plugin-pwa/vanillajs" />
/// <reference types="vite-plugin-pwa/info" />
/// <reference types="vite-plugin-svgr/client" />
interface ImportMetaEnv {
  // The port to run the dev server
  VITE_APP_PORT: string;

  VITE_APP_BACKEND_V2_GET_URL: string;
  VITE_APP_BACKEND_V2_POST_URL: string;

  // collaboration WebSocket server (https: string
  VITE_APP_WS_SERVER_URL: string;

  // set this only if using the collaboration workflow we use on excalidraw.com
  VITE_APP_PORTAL_URL: string;
  VITE_APP_AI_BACKEND: string;
  // IA local (fork ia-local): servidor compatível com a API da OpenAI
  VITE_APP_LOCAL_LLM_URL: string;
  // vazio = primeiro modelo listado pelo servidor
  VITE_APP_LOCAL_LLM_MODEL: string;
  // voz (fase 4b): whisper-server local (ia-local/README.md); vazio = só o
  // modelo no navegador, que também é o plano B quando o servidor está fora
  VITE_APP_LOCAL_ASR_URL: string;
  // voz (fase 4): "whisper-small" (padrão) ou "whisper-base"
  VITE_APP_LOCAL_ASR_MODEL: string;
  // "wasm" ou "webgpu"; vazio = WebGPU quando o navegador tiver
  VITE_APP_LOCAL_ASR_DEVICE: string;

  VITE_APP_FIREBASE_CONFIG: string;

  // whether to disable live reload / HMR. Usuaully what you want to do when
  // debugging Service Workers.
  VITE_APP_DEV_DISABLE_LIVE_RELOAD: string;

  VITE_APP_DISABLE_SENTRY: string;

  // Set this flag to false if you want to open the overlay by default
  VITE_APP_COLLAPSE_OVERLAY: string;

  // Enable eslint in dev server
  VITE_APP_ENABLE_ESLINT: string;

  // Enable PWA in dev server
  VITE_APP_ENABLE_PWA: string;

  VITE_APP_PLUS_LP: string;

  VITE_APP_PLUS_APP: string;

  VITE_APP_GIT_SHA: string;

  MODE: string;

  DEV: string;
  PROD: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
