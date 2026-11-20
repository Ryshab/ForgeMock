# MockForge

MockForge turns selected pages from competitive-exam response-sheet PDFs into timed CBT mock tests. PDF rendering and page slicing happen in the browser; selected page images are posted to the app's server-side extraction endpoint.

## Run locally

```sh
npm install
cp .env.example .env
npm run dev
```

Set `GEMINI_API_KEY` and optionally `GEMINI_MODEL` in the server `.env` for the server-side fallback. A server key is never included in the browser bundle. `GEMINI_TIMEOUT_MS` configures the total provider-operation deadline (default: 480000 ms); the Vite server HTTP timeouts are derived with a 30-second grace period. Existing transient retries share the same total deadline.

The **API Settings** panel accepts a Gemini BYOK key for both connection testing and PDF extraction. It stays in page memory, is sent in the request body only to this app's backend over HTTPS (loopback HTTP is allowed for development), and is cleared when the page session ends. It is not persisted. A key supplied in Settings takes precedence for that extraction request; when omitted, extraction uses the server-side `GEMINI_API_KEY` fallback. If neither Gemini key is available, set `LOVABLE_API_KEY` to use the existing Lovable AI gateway fallback (`google/gemini-2.5-flash`). The connection test allows 180 seconds in the browser, 185 seconds for the Gemini request, and 190 seconds for its Vercel function. Vercel extraction allows up to 300 seconds, with a 280-second server-side deadline. Obtain keys from [Google AI Studio](https://aistudio.google.com/app/apikey).

The same extraction middleware is attached to Vite development and preview servers. For production, run the app on a Node host that executes the Vite server middleware; a static-only host cannot provide the server-side AI endpoint.
