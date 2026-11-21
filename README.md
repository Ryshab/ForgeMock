# MockForge

MockForge turns selected pages from competitive-exam response-sheet PDFs into timed CBT mock tests. PDF rendering and page slicing happen in the browser; selected page images are posted to the app's server-side extraction endpoint.

## Run locally

```sh
npm install
cp .env.example .env
npm run dev
```

Set `GEMINI_API_KEY` and optionally `GEMINI_MODEL` in the server `.env`. The key is read by the Vite server and is not included in the browser bundle or network requests to the browser. `GEMINI_TIMEOUT_MS` configures the total provider-operation deadline (default: 480000 ms); the Vite server HTTP timeouts are derived with a 30-second grace period. Existing transient retries share the same total deadline.

If Gemini is not configured, set the server-side `LOVABLE_API_KEY` to use the existing Lovable AI gateway fallback (`google/gemini-2.5-flash`). The **API Settings** panel can test a user-provided Gemini key with a minimal server-side request. The key remains in browser memory only, is discarded when the page session ends, and is not used for PDF extraction; extraction continues to use the server environment configuration. Obtain keys from [Google AI Studio](https://aistudio.google.com/app/apikey). Key validation is accepted over HTTPS (with loopback HTTP allowed for local development).

The same extraction middleware is attached to Vite development and preview servers. For production, run the app on a Node host that executes the Vite server middleware; a static-only host cannot provide the server-side AI endpoint.
