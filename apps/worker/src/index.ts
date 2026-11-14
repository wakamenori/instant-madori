import { handleApi } from "./api/app.ts";
import { systemRuntime } from "./services/deps.ts";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Matches `run_worker_first: ["/api/*"]` in wrangler.jsonc; other paths are static assets.
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, url, env, systemRuntime);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export { GeometryContainer } from "./geometry/geometry-container.ts";
