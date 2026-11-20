import { getProviderTimeoutMs } from "./timeouts.server.js";

const GEMINI_CONNECTION_TIMEOUT_MS = 185_000;

export type ExtractionPage = {
  page: number;
  data: string;
};

type ProviderConfig =
  | { kind: "gemini"; key: string; model: string }
  | { kind: "lovable"; key: string; model: "google/gemini-2.5-flash" };

export type GeminiConnectionTestResult =
  | { status: "connected"; message: string }
  | { status: "invalid_key" | "quota" | "network" | "timeout" | "api_error"; message: string };

type ProviderRequest = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

type GeminiExtractionDiagnostics = {
  finishReason?: string;
  candidateCount: number;
  candidateTextExists: boolean;
};

export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export class ClientCancelledError extends Error {
  constructor() {
    super("Question extraction was cancelled.");
    this.name = "ClientCancelledError";
  }
}

function getGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
}

function getProvider(apiKey?: string): ProviderConfig {
  if (apiKey !== undefined) {
    const userKey = apiKey.trim();
    if (!userKey) {
      throw new ProviderRequestError("Enter a Gemini API key in Settings to use Gemini.", 400);
    }
    return {
      kind: "gemini",
      key: userKey,
      model: getGeminiModel(),
    };
  }

  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey) {
    return {
      kind: "gemini",
      key: geminiKey,
      model: getGeminiModel(),
    };
  }

  const lovableKey = process.env.LOVABLE_API_KEY?.trim();
  if (lovableKey) {
    return { kind: "lovable", key: lovableKey, model: "google/gemini-2.5-flash" };
  }

  throw new ProviderRequestError(
    "No AI provider is configured. Add a Gemini API key in Settings or configure a server-side provider.",
    503,
  );
}

function getGeminiErrorStatus(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return "";
  const error = payload.error;
  if (!error || typeof error !== "object") return "";
  return "status" in error && typeof error.status === "string" ? error.status : "";
}

function getGeminiErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return "";
  const error = payload.error;
  if (!error || typeof error !== "object") return "";
  return "message" in error && typeof error.message === "string" ? error.message : "";
}

function classifyGeminiError(statusCode: number, payload: unknown): GeminiConnectionTestResult {
  const status = getGeminiErrorStatus(payload).toUpperCase();
  const message = getGeminiErrorMessage(payload).toLowerCase();
  if (
    status === "API_KEY_INVALID" ||
    (statusCode === 401) ||
    (/api.?key/.test(message) && /(invalid|not valid|incorrect)/.test(message))
  ) {
    return { status: "invalid_key", message: "Google rejected this API key. Check that it is correct and active." };
  }
  if (
    statusCode === 429 ||
    status === "RESOURCE_EXHAUSTED" ||
    /(quota|rate.?limit|resource exhausted)/.test(message)
  ) {
    return { status: "quota", message: "The key is valid, but its Gemini quota or rate limit has been reached." };
  }
  return { status: "api_error", message: "Google Gemini could not complete the connection test. Check the key's API access and try again." };
}

function getGeminiExtractionErrorMessage(statusCode: number, responseText: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch {
    payload = undefined;
  }

  const result = classifyGeminiError(statusCode, payload);
  if (result.status === "invalid_key") {
    return "The Gemini API key is invalid. Check the key in Settings.";
  }
  if (result.status === "quota") {
    return "The Gemini quota or rate limit was reached. Try again later.";
  }
  return "Google Gemini could not complete PDF extraction. Check the key's API access and try again.";
}

export async function testGeminiApiKey(apiKey: string): Promise<GeminiConnectionTestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEMINI_CONNECTION_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(getGeminiModel())}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Reply with OK." }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
        signal: controller.signal,
      },
    );
    if (response.ok) return { status: "connected", message: "Connection successful. The API key is valid." };
    const payload: unknown = await response.json().catch(() => undefined);
    return classifyGeminiError(response.status, payload);
  } catch {
    if (controller.signal.aborted) {
      return { status: "timeout", message: "The connection test timed out. Try again in a moment." };
    }
    return { status: "network", message: "Could not reach Google Gemini. Check your network connection and try again." };
  } finally {
    clearTimeout(timeout);
  }
}

function getRequest(provider: ProviderConfig, prompt: string, pages: ExtractionPage[]): ProviderRequest {
  const pageParts = pages.flatMap(({ page, data }) => [
    { text: `Selected PDF page ${page}` },
    { inline_data: { mime_type: "image/png", data } },
  ]);
  if (provider.kind === "gemini") {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(provider.model)}:generateContent`,
      headers: { "x-goog-api-key": provider.key },
      body: {
        contents: [{ parts: [{ text: prompt }, ...pageParts] }],
        generationConfig: { responseMimeType: "application/json" },
      },
    };
  }

  const content = [
    { type: "text", text: prompt },
    ...pages.flatMap(({ page, data }) => [
      { type: "text", text: `Selected PDF page ${page}` },
      { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } },
    ]),
  ];
  return {
    url: "https://ai.gateway.lovable.dev/v1/chat/completions",
    headers: { Authorization: `Bearer ${provider.key}` },
    body: {
      model: provider.model,
      messages: [{ role: "user", content }],
      temperature: 0,
      response_format: { type: "json_object" },
    },
  };
}

async function requestProvider(
  providerName: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  clientSignal: AbortSignal,
): Promise<string> {
  const timeoutMs = getProviderTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (clientSignal.aborted) throw new ClientCancelledError();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ProviderRequestError(
        `${providerName} timed out after ${Math.ceil(timeoutMs / 1000)} seconds. Try fewer PDF pages.`,
        504,
      );
    }

    const requestController = new AbortController();
    const timeout = setTimeout(() => requestController.abort(), remainingMs);
    const onClientAbort = () => requestController.abort();
    clientSignal.addEventListener("abort", onClientAbort, { once: true });

    let retry = false;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: requestController.signal,
      });
      const responseText = await response.text();
      if (clientSignal.aborted) throw new ClientCancelledError();
      if (requestController.signal.aborted) {
        throw new ProviderRequestError(
          `${providerName} timed out after ${Math.ceil(timeoutMs / 1000)} seconds. Try fewer PDF pages.`,
          504,
        );
      }

      if (response.ok) return responseText;

      const transient = response.status === 429 || response.status >= 500;
      if (transient && attempt < maxAttempts) {
        retry = true;
      } else {
        const message = providerName === "Gemini"
          ? getGeminiExtractionErrorMessage(response.status, responseText)
          : `${providerName} request failed (${response.status}): ${responseText.slice(0, 400) || response.statusText}`;
        throw new ProviderRequestError(
          message,
          response.status >= 500 ? 502 : response.status,
        );
      }
    } catch (reason) {
      if (clientSignal.aborted) throw new ClientCancelledError();
      if (reason instanceof ProviderRequestError || reason instanceof ClientCancelledError) throw reason;
      if (requestController.signal.aborted) {
        throw new ProviderRequestError(
          `${providerName} timed out after ${Math.ceil(timeoutMs / 1000)} seconds. Try fewer PDF pages.`,
          504,
        );
      }

      if (attempt < maxAttempts) {
        retry = true;
      } else {
        const detail = providerName === "Gemini"
          ? "Check the network connection and try again."
          : reason instanceof Error ? reason.message : String(reason);
        throw new ProviderRequestError(`${providerName} network request failed: ${detail}`, 502);
      }
    } finally {
      clearTimeout(timeout);
      clientSignal.removeEventListener("abort", onClientAbort);
    }

    if (retry) {
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      if (clientSignal.aborted) throw new ClientCancelledError();
    }
  }

  throw new ProviderRequestError(
    `${providerName} timed out after ${Math.ceil(getProviderTimeoutMs() / 1000)} seconds. Try fewer PDF pages.`,
    504,
  );
}

function parseJsonResponse(
  text: string,
  providerName = "The AI provider",
  geminiDiagnostics?: GeminiExtractionDiagnostics,
): unknown {
  const trimmedText = text.trim();
  const openingFenceStripped = /^```(?:json)?\s*/i.test(trimmedText);
  const closingFenceStripped = /\s*```$/.test(trimmedText);
  const cleanText = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleanText) as unknown;
  } catch (error) {
    if (geminiDiagnostics) {
      const cleanTrimmedText = cleanText.trim();
      const startsWithObjectBrace = cleanTrimmedText.startsWith("{");
      const endsWithObjectBrace = cleanTrimmedText.endsWith("}");
      const parseErrorMessage = error instanceof SyntaxError ? error.message : "";
      const jsonErrorCategory = error instanceof SyntaxError
        ? parseErrorMessage.toLowerCase().includes("unexpected end")
          ? "unexpected_end"
          : parseErrorMessage.toLowerCase().includes("unterminated string")
            ? "unterminated_string"
            : parseErrorMessage.toLowerCase().includes("unexpected token")
              ? "unexpected_token"
              : parseErrorMessage.toLowerCase().includes("expected")
                ? "invalid_structure"
                : "syntax_error"
        : "unknown";
      const positionMatch = /\bposition\s+(\d+)\b/i.exec(parseErrorMessage);

      console.error("Gemini extraction JSON parsing failed", {
        finishReason: geminiDiagnostics.finishReason ?? "UNKNOWN",
        candidateCount: geminiDiagnostics.candidateCount,
        candidateTextExists: geminiDiagnostics.candidateTextExists,
        extractedResponseTextLength: text.length,
        markdownCodeFenceDetectedAndStripped: openingFenceStripped || closingFenceStripped,
        startsWithObjectBrace,
        endsWithObjectBrace,
        jsonErrorCategory,
        jsonErrorPosition: positionMatch ? Number(positionMatch[1]) : null,
        appearsTruncated:
          geminiDiagnostics.finishReason === "MAX_TOKENS" ||
          geminiDiagnostics.finishReason === "CONTINUATION" ||
          jsonErrorCategory === "unexpected_end" ||
          jsonErrorCategory === "unterminated_string" ||
          (startsWithObjectBrace && !endsWithObjectBrace),
      });
    }
    throw new ProviderRequestError(
      `${providerName} returned malformed extraction JSON. No questions were accepted.`,
      502,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function providerReason(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z_]{1,48}$/.test(value) && value !== "BLOCK_REASON_UNSPECIFIED"
    ? value
    : undefined;
}

function extractGeminiText(parsed: unknown): {
  text: string;
  diagnostics: GeminiExtractionDiagnostics;
} {
  const response = asRecord(parsed);
  if (!response) {
    throw new ProviderRequestError(
      "Gemini returned a malformed API response instead of a response object.",
      502,
    );
  }

  const promptFeedback = asRecord(response.promptFeedback);
  const blockReason = providerReason(promptFeedback?.blockReason);
  if (blockReason) {
    throw new ProviderRequestError(
      `Gemini blocked the extraction prompt (${blockReason}). Check the selected pages and retry.`,
      502,
    );
  }

  if (!Array.isArray(response.candidates)) {
    throw new ProviderRequestError(
      "Gemini returned no candidates; the response did not contain a candidates array.",
      502,
    );
  }
  if (response.candidates.length === 0) {
    throw new ProviderRequestError(
      "Gemini returned no candidates. Check the extraction prompt feedback and retry.",
      502,
    );
  }

  const candidate = asRecord(response.candidates[0]);
  if (!candidate) {
    throw new ProviderRequestError("Gemini returned a malformed candidate.", 502);
  }

  const finishReason = providerReason(candidate.finishReason);
  if (finishReason === "MAX_TOKENS" || finishReason === "CONTINUATION") {
    throw new ProviderRequestError(
      `Gemini truncated the extraction at its output limit (${finishReason}). Select fewer pages and retry.`,
      502,
    );
  }
  if (finishReason === "SAFETY" || finishReason === "IMAGE_SAFETY") {
    throw new ProviderRequestError(
      `Gemini blocked the candidate for safety reasons (${finishReason}). Review the selected pages and retry.`,
      502,
    );
  }
  if (
    finishReason &&
    [
      "RECITATION",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII",
      "IMAGE_PROHIBITED_CONTENT",
      "IMAGE_RECITATION",
      "ESCALATION",
      "PUP_LIMITED_DISABLED",
    ].includes(finishReason)
  ) {
    throw new ProviderRequestError(
      `Gemini filtered the candidate (${finishReason}). Review the selected pages and retry.`,
      502,
    );
  }
  if (
    finishReason === "MALFORMED_RESPONSE" ||
    finishReason === "MALFORMED_FUNCTION_CALL" ||
    finishReason === "MISSING_THOUGHT_SIGNATURE"
  ) {
    throw new ProviderRequestError(
      `Gemini returned a malformed candidate (${finishReason}). No questions were accepted.`,
      502,
    );
  }

  const content = asRecord(candidate.content);
  if (!content || !Array.isArray(content.parts)) {
    throw new ProviderRequestError(
      `Gemini returned a candidate without content parts${finishReason ? ` (${finishReason})` : ""}.`,
      502,
    );
  }

  const text = content.parts
    .map(asRecord)
    .filter((part): part is Record<string, unknown> => part !== undefined && part.thought !== true)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
  if (!text.trim()) {
    throw new ProviderRequestError(
      `Gemini returned a candidate without final text content${finishReason ? ` (${finishReason})` : ""}.`,
      502,
    );
  }
  return {
    text,
    diagnostics: {
      finishReason,
      candidateCount: response.candidates.length,
      candidateTextExists: true,
    },
  };
}

export async function generateQuestionExtraction(
  prompt: string,
  pages: ExtractionPage[],
  clientSignal: AbortSignal,
  apiKey?: string,
): Promise<unknown> {
  const provider = getProvider(apiKey);
  const request = getRequest(provider, prompt, pages);
  const providerName = provider.kind === "gemini" ? "Gemini" : "Lovable AI";
  const responseText = await requestProvider(
    providerName,
    request.url,
    request.headers,
    request.body,
    clientSignal,
  );
  if (!responseText.trim()) {
    throw new ProviderRequestError(`${providerName} returned an empty response.`, 502);
  }
  let result: unknown;
  try {
    result = JSON.parse(responseText) as unknown;
  } catch {
    throw new ProviderRequestError(
      `${providerName} returned malformed API JSON. No questions were accepted.`,
      502,
    );
  }

  if (provider.kind === "gemini") {
    const output = extractGeminiText(result);
    return parseJsonResponse(output.text, "Gemini", output.diagnostics);
  }

  const payload = result as { choices?: { message?: { content?: string | { text?: string }[] } }[] };
  const output = payload.choices?.[0]?.message?.content;
  const text = typeof output === "string"
    ? output
    : Array.isArray(output)
      ? output.map((part) => part.text ?? "").join("")
      : "";
  if (!text) throw new ProviderRequestError("Lovable AI returned an empty extraction response.", 502);
  return parseJsonResponse(text, "Lovable AI");
}
