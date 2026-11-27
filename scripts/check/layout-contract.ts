import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
const bindingSchema = z.object({
  durable_objects: z.object({
    bindings: z.array(z.object({ name: z.string(), class_name: z.string() })),
  }),
  containers: z.array(z.object({ class_name: z.string() })),
  exports: z.record(z.string(), z.unknown()),
  r2_buckets: z.array(z.object({ binding: z.string() })),
  d1_databases: z.array(z.object({ binding: z.string() })),
  vars: z.record(z.string(), z.unknown()),
});
function names(value: z.infer<typeof bindingSchema>) {
  return {
    durable_objects: value.durable_objects.bindings.map((b) => `${b.name}:${b.class_name}`).sort(),
    containers: value.containers.map((c) => c.class_name).sort(),
    exports: Object.keys(value.exports).sort(),
    r2_buckets: value.r2_buckets.map((b) => b.binding).sort(),
    d1_databases: value.d1_databases.map((d) => d.binding).sort(),
    vars: Object.keys(value.vars).sort(),
  };
}
export function assertStagingBindings(config: unknown): void {
  const inherited = z.object({
    $schema: z.unknown().optional(),
    name: z.unknown().optional(),
    main: z.unknown().optional(),
    compatibility_date: z.unknown().optional(),
    compatibility_flags: z.unknown().optional(),
    workers_dev: z.unknown().optional(),
    preview_urls: z.unknown().optional(),
    triggers: z.unknown().optional(),
    observability: z.unknown().optional(),
    assets: z.unknown().optional(),
    env: z.unknown().optional(),
  });
  // Local-only secrets (the dev JWKS) are declared for type generation; staging declares none.
  const top = bindingSchema
    .extend(inherited.shape)
    .extend({
      secrets: z
        .object({ required: z.array(z.string()) })
        .strict()
        .optional(),
    })
    .strict()
    .parse(config);
  const staging = z
    .object({
      env: z.object({
        staging: bindingSchema
          .extend({
            ...inherited.omit({ env: true }).shape,
            d1_databases: z.array(
              z.strictObject({
                binding: z.string(),
                database_name: z.string(),
                database_id: z.string(),
                migrations_dir: z.literal("migrations"),
              }),
            ),
          })
          .strict(),
      }),
    })
    .parse(config).env.staging;
  if (JSON.stringify(names(top)) !== JSON.stringify(names(staging)))
    throw new Error("staging binding names must equal top-level binding names");
}
export function assertContainerE2eFiles(files: string[]): void {
  if (files.length !== 1 || files[0] !== "apps/worker/tests/container.e2e.ts")
    throw new Error(
      "All container e2e cases must be subtests of apps/worker/tests/container.e2e.ts to share one Docker boot",
    );
}

export function upstreamFilePath(root: URL, path: string): string {
  return join(fileURLToPath(root), "third_party/solidcraft", path);
}
