import type { IncomingMessage, ServerResponse } from "node:http";
import type { NextFunction } from "connect";
import { handleGeminiValidationRequest } from "./gemini-validation.server.js";

function respond(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.end(JSON.stringify(body));
}

export function geminiValidationMiddleware(
  request: IncomingMessage,
  response: ServerResponse,
  next: NextFunction,
): void {
  if (request.method !== "POST") {
    next();
    return;
  }

  void (async () => {
    const result = await handleGeminiValidationRequest(request);
    if (!response.destroyed) respond(response, result.statusCode, result.body);
  })();
}
