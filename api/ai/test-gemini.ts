import type { IncomingMessage, ServerResponse } from "node:http";
import { handleGeminiValidationRequest } from "../../src/lib/gemini-validation.server";

type VercelRequest = IncomingMessage;
type VercelResponse = ServerResponse;

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(request: VercelRequest, response: VercelResponse): Promise<void> {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.statusCode = 405;
    response.end(JSON.stringify({ error: "Method not allowed." }));
    return;
  }

  const result = await handleGeminiValidationRequest(request);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.statusCode = result.statusCode;
  response.end(JSON.stringify(result.body));
}
