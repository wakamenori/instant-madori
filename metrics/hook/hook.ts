import { spool } from "./spool.ts";
try {
  spool(process.env, process.argv[2] === "permission");
} catch {
  /* Collection failures must stay out of agent sessions. */
}
