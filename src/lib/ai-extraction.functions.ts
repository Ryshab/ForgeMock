import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NextFunction } from "connect";
import {
  ClientCancelledError,
  generateQuestionExtraction,
  ProviderRequestError,
} from "./ai/providers.server.js";
import type { ExtractionPage } from "./ai/providers.server.js";
import { isSecureRequest } from "./gemini-validation.server.js";

type ExtractionRequest = {
  prompt: string;
  pages: ExtractionPage[];
  apiKey?: string;
};

export class ExtractionRequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "ExtractionRequestError";
  }
}

class RequestBodyError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "RequestBodyError";
  }
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += data.byteLength;
    if (totalBytes > 100 * 1024 * 1024) {
      throw new RequestBodyError("The selected page images exceed the 100 MB request limit.", 413);
    }
    chunks.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestBodyError("Request body must be valid JSON.", 400);
  }
}

function respond(response: ServerResponse, statusCode: number, body: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

export function aiExtractionMiddleware(
  request: IncomingMessage,
  response: ServerResponse,
  next: NextFunction,
  options: { timeoutMs?: number } = {},
): void {
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.method !== "POST") {
    next();
    return;
  }

  const controller = new AbortController();
  let clientDisconnected = false;
  let timedOut = false;
  const abortOnDisconnect = () => {
    if (!response.writableEnded) {
      clientDisconnected = true;
      controller.abort();
    }
  };
  request.once("aborted", abortOnDisconnect);
  response.once("close", abortOnDisconnect);
  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);

  void (async () => {
    try {
      const body = await readRequestBody(request);
      if (
        body !== null &&
        typeof body === "object" &&
        "apiKey" in body &&
        !isSecureRequest(request)
      ) {
        throw new ExtractionRequestError(
          "Use HTTPS to send a Gemini API key. Localhost is allowed for development.",
          400,
        );
      }
      if (controller.signal.aborted) {
        if (timedOut && !response.destroyed) {
          respond(response, 504, { error: "AI extraction timed out before the function duration limit." });
        }
        return;
      }
      const result = await extractQuestionsOnServer(body, controller.signal);
      if (timedOut && !response.destroyed) {
        respond(response, 504, { error: "AI extraction timed out before the function duration limit." });
      } else if (!controller.signal.aborted && !response.destroyed) {
        respond(response, 200, result);
      }
    } catch (reason) {
      if (clientDisconnected || response.destroyed) return;
      if (timedOut) {
        respond(response, 504, { error: "AI extraction timed out before the function duration limit." });
        return;
      }
      if (reason instanceof ClientCancelledError || controller.signal.aborted) return;
      if (reason instanceof RequestBodyError || reason instanceof ExtractionRequestError) {
        respond(response, reason.statusCode, { error: reason.message });
        return;
      }
      if (reason instanceof ProviderRequestError) {
        respond(response, reason.statusCode, { error: reason.message });
        return;
      }
      respond(response, 500, { error: "AI extraction failed unexpectedly. Try again." });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      request.removeListener("aborted", abortOnDisconnect);
      response.removeListener("close", abortOnDisconnect);
    }
  })();
}

export async function extractQuestionsOnServer(
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (!input || typeof input !== "object") {
    throw new ExtractionRequestError("Request body must be a JSON object.", 400);
  }
  const request = input as Partial<ExtractionRequest>;
  if (
    "apiKey" in request &&
    (typeof request.apiKey !== "string" || !request.apiKey.trim())
  ) {
    throw new ExtractionRequestError("Enter a valid Gemini API key in Settings.", 400);
  }
  if (
    typeof request.prompt !== "string" ||
    request.prompt.length === 0 ||
    !Array.isArray(request.pages) ||
    request.pages.length === 0 ||
    request.pages.some((page) =>
      !page ||
      !Number.isInteger(page.page) ||
      typeof page.data !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(page.data)
    )
  ) {
    throw new ExtractionRequestError("Provide the extraction prompt and selected page images.", 400);
  }

  try {
    return await generateQuestionExtraction(
      request.prompt,
      request.pages,
      signal,
      typeof request.apiKey === "string" ? request.apiKey.trim() : undefined,
    );
  } catch (reason) {
    if (reason instanceof ClientCancelledError || reason instanceof ProviderRequestError) throw reason;
    throw new ProviderRequestError("AI extraction failed unexpectedly. Try again.", 502);
  }
}
