import { defineConfig, loadEnv, type Plugin } from "vite";

// WebMCP requires an origin-isolated document. `Origin-Agent-Cluster: ?1`
// is sent in dev here and by the Worker in production (see src/worker.ts).
const ORIGIN_ISOLATION_HEADERS = {
  "Origin-Agent-Cluster": "?1",
};

const originTrialMeta = (token: string | undefined): Plugin => ({
  name: "locuslocal:origin-trial-meta",
  transformIndexHtml() {
    if (!token) {
      return [];
    }
    return [
      {
        attrs: { content: token, "http-equiv": "origin-trial" },
        injectTo: "head-prepend" as const,
        tag: "meta",
      },
    ];
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "VITE_");
  return {
    build: { outDir: "dist", target: "es2023" },
    plugins: [originTrialMeta(env.VITE_ORIGIN_TRIAL_TOKEN)],
    preview: { headers: ORIGIN_ISOLATION_HEADERS, port: 4173 },
    server: { headers: ORIGIN_ISOLATION_HEADERS, port: 5173 },
  };
});
