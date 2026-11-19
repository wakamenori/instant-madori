import { jobTestHoldSettingSchema } from "../services/job-test-hold.ts";
import { z } from "zod";

/**
 * Locally signed Access tokens are accepted only in the `local` environment and only for an
 * issuer under the reserved `.invalid` domain. Either check alone would let one misplaced
 * setting authenticate production requests with a development key.
 */
const localIssuerSuffix = ".invalid";

const originSchema = z
  .url()
  .refine((value) => new URL(value).origin === value, "must be a bare origin");

const jwksSchema = z.object({
  keys: z.array(z.looseObject({ kty: z.string() })).min(1),
});

const envSchema = z
  .object({
    JOB_TEST_HOLD: z.string().optional(),
    ENVIRONMENT: z.enum(["local", "staging", "production"]),
    /**
     * Space-separated Origins allowed to send mutating requests (CSRF defense behind
     * Access). Deployments list the one app origin; local runs list the dev server's names.
     */
    APP_ORIGINS: z
      .string()
      .transform((value) => value.split(/\s+/).filter((origin) => origin !== ""))
      .pipe(z.array(originSchema).min(1)),
    /** `https://<team>.cloudflareaccess.com`; also the expected JWT issuer. */
    ACCESS_TEAM_DOMAIN: originSchema.refine((value) => value.startsWith("https://")),
    /** The Access application's audience tag. */
    ACCESS_AUD: z.string().min(1),
    /** Local development only: the public JWKS of the generated development key. */
    ACCESS_JWKS: z.string().min(1).optional(),
    ACCESS_VERIFIER_CLIENT_ID: z.string().trim().min(1).optional(),
  })
  .transform((env, context) => {
    const hold = jobTestHoldSettingSchema.safeParse(env);
    if (!hold.success) {
      for (const issue of hold.error.issues)
        context.addIssue({ code: "custom", path: issue.path, message: issue.message });
      return z.NEVER;
    }
    const localIssuer = new URL(env.ACCESS_TEAM_DOMAIN).hostname.endsWith(localIssuerSuffix);
    const local = env.ENVIRONMENT === "local";
    if (local !== localIssuer || local !== (env.ACCESS_JWKS !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "local keys require ENVIRONMENT=local, an .invalid issuer and ACCESS_JWKS",
      });
      return z.NEVER;
    }
    if (env.ACCESS_VERIFIER_CLIENT_ID !== undefined && env.ENVIRONMENT !== "staging") {
      context.addIssue({
        code: "custom",
        path: ["ACCESS_VERIFIER_CLIENT_ID"],
        message: "the verifier service token requires ENVIRONMENT=staging",
      });
      return z.NEVER;
    }
    let keys: AccessKeys = { kind: "remote" };
    if (env.ACCESS_JWKS !== undefined) {
      const jwks = jwksSchema.safeParse(parseJson(env.ACCESS_JWKS));
      if (!jwks.success) {
        context.addIssue({ code: "custom", path: ["ACCESS_JWKS"], message: "invalid JWKS" });
        return z.NEVER;
      }
      keys = { kind: "local", jwks: jwks.data, source: env.ACCESS_JWKS };
    }
    return {
      appOrigins: new Set(env.APP_ORIGINS),
      access: {
        issuer: env.ACCESS_TEAM_DOMAIN,
        audience: env.ACCESS_AUD,
        keys,
        ...(env.ACCESS_VERIFIER_CLIENT_ID === undefined
          ? {}
          : { verifierClientId: env.ACCESS_VERIFIER_CLIENT_ID }),
      },
    };
  });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `source` is the raw ACCESS_JWKS text, used as a stable cache key for the key set. */
type AccessKeys =
  { kind: "remote" } | { kind: "local"; jwks: z.infer<typeof jwksSchema>; source: string };

export type AccessConfig = AppConfig["access"];

export type AppConfig = z.output<typeof envSchema>;

/** A deployment setting is missing or inconsistent; requests fail closed with a 500. */
class ConfigError extends Error {
  constructor(fields: string[]) {
    super(`Invalid Worker configuration: ${fields.join(", ")}`);
    this.name = "ConfigError";
  }
}

const loaded = new WeakMap<object, AppConfig>();

/**
 * Parses the Worker settings once per `env` object; they cannot change while an isolate
 * runs. Takes the bindings as a plain object so the parsing does not depend on `Env`.
 */
export function loadConfig(env: object): AppConfig {
  const cached = loaded.get(env);
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Report which settings are wrong, never their values.
    throw new ConfigError(
      parsed.error.issues.map((issue) => issue.path.join(".") || "(combination)"),
    );
  }
  loaded.set(env, parsed.data);
  return parsed.data;
}
