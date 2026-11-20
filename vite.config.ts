import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { loadEnv } from "vite";
import { aiExtractionMiddleware } from "./src/lib/ai-extraction.functions";
import { geminiValidationMiddleware } from "./src/lib/gemini-validation.functions";
import { getExtractionHttpTimeoutMs } from "./src/lib/ai/timeouts.server";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");
  process.env.GEMINI_API_KEY ??= environment.GEMINI_API_KEY;
  process.env.GEMINI_MODEL ??= environment.GEMINI_MODEL;
  if (process.env.GEMINI_TIMEOUT_MS === undefined && environment.GEMINI_TIMEOUT_MS !== undefined) {
    process.env.GEMINI_TIMEOUT_MS = environment.GEMINI_TIMEOUT_MS;
  }
  process.env.LOVABLE_API_KEY ??= environment.LOVABLE_API_KEY;

  const configureHttpTimeout = (
    httpServer: {
      setTimeout: (milliseconds?: number, callback?: () => void) => unknown;
      requestTimeout?: number;
    } | null,
  ) => {
    if (!httpServer) return;
    const timeoutMs = getExtractionHttpTimeoutMs();
    httpServer.setTimeout(timeoutMs);
    if ("requestTimeout" in httpServer) httpServer.requestTimeout = timeoutMs;
  };

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "mockforge-server-ai-extraction",
        configureServer(server) {
          configureHttpTimeout(server.httpServer);
          server.middlewares.use("/api/ai/extract", aiExtractionMiddleware);
          server.middlewares.use("/api/ai/test-gemini", geminiValidationMiddleware);
        },
        configurePreviewServer(server) {
          configureHttpTimeout(server.httpServer);
          server.middlewares.use("/api/ai/extract", aiExtractionMiddleware);
          server.middlewares.use("/api/ai/test-gemini", geminiValidationMiddleware);
        },
      },
    ],
  };
});
