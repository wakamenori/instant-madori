import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { metricsHome } from "../home.ts";
import { captureProject, publish } from "./spool.ts";

try {
  const home = metricsHome(process.env);
  if (existsSync(home.ready)) {
    const input: unknown = JSON.parse(readFileSync(0, "utf8"));
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const fields = [
        "hook_event_name",
        "session_id",
        "turn_id",
        "cwd",
        "transcript_path",
        "model",
        "permission_mode",
        "source",
        "agent_id",
        "agent_type",
        "tool_name",
        "tool_use_id",
        "tool_input",
        "prompt",
        "last_assistant_message",
        "stop_hook_active",
      ];
      const at = new Date();
      const id = randomUUID();
      publish(home, "codex-hook-" + at.getTime() + "-" + id + ".json", {
        v: 1,
        id,
        at: at.toISOString(),
        stdin: JSON.stringify(
          Object.fromEntries(Object.entries(input).filter(([key]) => fields.includes(key))),
        ),
        project: captureProject(process.cwd()),
        env: {
          T3CODE_THREAD_ID: process.env.T3CODE_THREAD_ID,
          CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
        },
      });
    }
  }
} catch {
  /* Collection failures must stay out of agent sessions. */
}
