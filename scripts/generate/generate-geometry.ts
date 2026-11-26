import { readFile, writeFile } from "node:fs/promises";
import { repositoryRoot } from "../shared/repository.ts";
import { renderAiTools } from "./ai-tools.ts";
import { renderGeometrySchemas } from "./geometry-schema.ts";
const directory = new URL("packages/contracts/src/generated/", repositoryRoot);
const input: unknown = JSON.parse(
  await readFile(new URL("geometry-internal.schema.json", directory), "utf8"),
);
await writeFile(new URL("geometry-bodies.ts", directory), renderGeometrySchemas(input));
const tools: unknown = JSON.parse(
  await readFile(new URL("ai-tools.schema.json", directory), "utf8"),
);
await writeFile(new URL("ai-tools.ts", directory), renderAiTools(tools));
