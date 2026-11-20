import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";
import {
  testGeminiApiKey,
  type GeminiConnectionTestResult,
} from "./ai/providers.server.js";

export class GeminiValidationRequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "GeminiValidationRequestError";
  }
}

export function isSecureRequest(request: IncomingMessage): boolean {
  if (request.socket instanceof TLSSocket) return true;
  const forwardedProto = request.headers["x-forwarded-proto"];
  if (typeof forwardedProto === "string" && forwardedProto.split(",")[0].trim() === "https") return true;
  const remoteAddress = request.socket.remoteAddress ?? "";
  return remoteAddress === "::1" ||
    remoteAddress === "127.0.0.1" ||
    remoteAddress.startsWith("::ffff:127.");
}

async function readApiKey(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += data.byteLength;
    if (totalBytes > 8 * 1024) {
      throw new GeminiValidationRequestError("Request body exceeds the allowed size.", 413);
    }
    chunks.push(data);
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new GeminiValidationRequestError("Request body must be valid JSON.", 400);
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("apiKey" in body) ||
    typeof body.apiKey !== "string" ||
    !body.apiKey.trim()
  ) {
    throw new GeminiValidationRequestError("Enter a Gemini API key to test the connection.", 400);
  }
  return body.apiKey.trim();
}

export async function handleGeminiValidationRequest(
  request: IncomingMessage,
): Promise<{ statusCode: number; body: GeminiConnectionTestResult | { error: string } }> {
  let stage = "request_validation";
  try {
    if (!isSecureRequest(request)) {
      throw new GeminiValidationRequestError("Use HTTPS to test an API key.", 400);
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      throw new GeminiValidationRequestError("Request must use application/json.", 415);
    }
    const apiKey = await readApiKey(request);
    stage = "gemini_request";
    return { statusCode: 200, body: await testGeminiApiKey(apiKey) };
  } catch (reason) {
    if (reason instanceof GeminiValidationRequestError) {
      return { statusCode: reason.statusCode, body: { error: reason.message } };
    }
    console.error("[gemini-validation] unexpected failure", {
      stage,
      errorType: reason instanceof Error ? reason.name : typeof reason,
    });
    return { statusCode: 500, body: { error: "The Gemini connection test could not be completed." } };
  }
}
