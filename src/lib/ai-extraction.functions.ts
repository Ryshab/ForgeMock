import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { NextFunction } from "connect";
import {
  ClientCancelledError,
  generateQuestionExtraction,
  ProviderRequestError,
} from "./ai/providers.server";
import type { ExtractionPage } from "./ai/providers.server";

type ExtractionRequest = {
  prompt: string;
  pages: ExtractionPage[];
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
  const abortOnDisconnect = () => {
    if (!response.writableEnded) controller.abort();
  };
  request.once("aborted", abortOnDisconnect);
  response.once("close", abortOnDisconnect);

  void (async () => {
    try {
      const body = await readRequestBody(request);
      if (controller.signal.aborted) return;
      const result = await extractQuestionsOnServer(body, controller.signal);
      if (!controller.signal.aborted && !response.destroyed) respond(response, 200, result);
    } catch (reason) {
      if (reason instanceof ClientCancelledError || controller.signal.aborted || response.destroyed) return;
      if (reason instanceof RequestBodyError || reason instanceof ExtractionRequestError) {
        respond(response, reason.statusCode, { error: reason.message });
        return;
      }
      if (reason instanceof ProviderRequestError) {
        respond(response, reason.statusCode, { error: reason.message });
        return;
      }
      respond(response, 500, {
        error: `AI extraction failed unexpectedly: ${reason instanceof Error ? reason.message : String(reason)}`,
      });
    } finally {
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
    return await generateQuestionExtraction(request.prompt, request.pages, signal);
  } catch (reason) {
    if (reason instanceof ClientCancelledError || reason instanceof ProviderRequestError) throw reason;
    throw new ProviderRequestError(
      `AI extraction failed unexpectedly: ${reason instanceof Error ? reason.message : String(reason)}`,
      502,
    );
  }
}
