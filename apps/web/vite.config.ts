import { defineConfig } from "vite";
import type { ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { accessAssertionHeader } from "@madori/contracts";
import { devWorkerPort } from "../../scripts/dev/dev-session.ts";
import { devAccess, readAccessKey, signAccessToken } from "../../scripts/dev/local-access.ts";

/** Signed once at startup; long enough that a running dev server never sees it expire. */
const tokenLifetimeSeconds = 365 * 24 * 60 * 60;

/**
 * In development the proxy plays Cloudflare Access. It always removes the assertion the
 * client sent and, when `pnpm dev` has generated the local key, adds a token for the local
 * developer. Without the key no assertion reaches the Worker, which then answers 401.
 * Production builds never read the key.
 */
async function apiProxy(): Promise<ProxyOptions> {
  let token: string | null = null;
  try {
    token = await signAccessToken(await readAccessKey(), devAccess.user(), {
      expiresAt: Math.floor(Date.now() / 1000) + tokenLifetimeSeconds,
    });
  } catch (error) {
    console.warn(error instanceof Error ? error.message : error);
    console.warn("API requests will be unauthenticated until the dev server restarts.");
  }
  return {
    target: `http://127.0.0.1:${devWorkerPort(process.env)}`,
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq) => {
        proxyReq.removeHeader(accessAssertionHeader);
        if (token !== null) proxyReq.setHeader(accessAssertionHeader, token);
      });
    },
  };
}

// Only the dev server signs requests; `vite preview` of the production build does not.
// CORS stays off so other local pages cannot read API responses the proxy authenticated.
export default defineConfig(async ({ command, isPreview }) => ({
  clearScreen: false,
  plugins: [react()],
  server:
    command === "serve" && isPreview !== true
      ? { cors: false, proxy: { "/api": await apiProxy() } }
      : {},
  preview: { cors: false, proxy: {} },
}));
