import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import type { NextFunction } from "connect";
import { testGeminiApiKey } from "./ai/providers.server";

class ValidationRequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "ValidationRequestError";
  }
}

async function readApiKey(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += data.byteLength;
    if (totalBytes > 8 * 1024) {
      throw new ValidationRequestError("Request body exceeds the allowed size.", 413);
    }
    chunks.push(data);
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ValidationRequestError("Request body must be valid JSON.", 400);
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("apiKey" in body) ||
    typeof body.apiKey !== "string" ||
    !body.apiKey.trim()
  ) {
    throw new ValidationRequestError("Enter a Gemini API key to test the connection.", 400);
  }
  return body.apiKey.trim();
}

function isSecureRequest(request: IncomingMessage): boolean {
  if (request.socket instanceof TLSSocket) return true;
  const forwardedProto = request.headers["x-forwarded-proto"];
  if (typeof forwardedProto === "string" && forwardedProto.split(",")[0].trim() === "https") return true;
  const remoteAddress = request.socket.remoteAddress ?? "";
  return remoteAddress === "::1" ||
    remoteAddress === "127.0.0.1" ||
    remoteAddress.startsWith("::ffff:127.");
}

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
    try {
      if (!isSecureRequest(request)) {
        throw new ValidationRequestError("Use HTTPS to test an API key.", 400);
      }
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        throw new ValidationRequestError("Request must use application/json.", 415);
      }
      const apiKey = await readApiKey(request);
      const result = await testGeminiApiKey(apiKey);
      if (!response.destroyed) respond(response, 200, result);
    } catch (reason) {
      if (response.destroyed) return;
      if (reason instanceof ValidationRequestError) {
        respond(response, reason.statusCode, { error: reason.message });
        return;
      }
      respond(response, 500, { error: "The Gemini connection test could not be completed." });
    }
  })();
}
