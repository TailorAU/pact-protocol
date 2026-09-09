import { defineConfig, loadEnv } from "vite";

// Dev serves the app same-origin and proxies /api/intel to the api package
// (default 127.0.0.1:4200; override with VITE_API_TARGET). The SSE stream
// rides the same proxy. Build stays fully self-contained — no CDN, no fonts.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_TARGET || "http://127.0.0.1:4200";
  return {
    server: {
      proxy: {
        "/api/intel": {
          target,
          changeOrigin: true,
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 1500,
    },
  };
});
