const DEFAULT_PROVIDER_TIMEOUT_MS = 480_000;
const HTTP_TIMEOUT_GRACE_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647 - HTTP_TIMEOUT_GRACE_MS;

export function getProviderTimeoutMs(): number {
  const configuredTimeout = process.env.GEMINI_TIMEOUT_MS?.trim();
  if (!configuredTimeout) return DEFAULT_PROVIDER_TIMEOUT_MS;

  const timeoutMs = Number(configuredTimeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`GEMINI_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  return timeoutMs;
}

export function getExtractionHttpTimeoutMs(): number {
  return getProviderTimeoutMs() + HTTP_TIMEOUT_GRACE_MS;
}
