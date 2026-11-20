import type { IncomingMessage, ServerResponse } from "node:http";
import { aiExtractionMiddleware } from "../../src/lib/ai-extraction.functions.js";

const RESPONSE_MARGIN_MS = 20_000;

export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 300,
};

export default function handler(request: IncomingMessage, response: ServerResponse): void {
  aiExtractionMiddleware(request, response, () => {
    response.setHeader("Allow", "POST, OPTIONS");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.statusCode = 405;
    response.end(JSON.stringify({ error: "Method not allowed." }));
  }, {
    timeoutMs: 300_000 - RESPONSE_MARGIN_MS,
  });
}
