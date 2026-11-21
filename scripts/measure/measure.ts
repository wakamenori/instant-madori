import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { workersLogs, formatLogRows, parseLogRows } from "./workers-logs.ts";
import { waitCold } from "./cold.ts";
import { deployStaging } from "./deploy.ts";
import { summarize } from "./summary.ts";

async function readToken() {
  const path = process.env.CF_API_TOKEN_FILE;
  if (!path) throw new Error("Set CF_API_TOKEN_FILE to the token file path");
  const token = await readFile(path, "utf8").then(
    (text) => text.trim(),
    () => {
      throw new Error("Cannot read the file named by CF_API_TOKEN_FILE");
    },
  );
  if (!token || /\s/u.test(token)) throw new Error("Invalid token in CF_API_TOKEN_FILE");
  return token;
}

async function main([command, ...args]: string[]) {
  switch (command ?? "") {
    case "logs": {
      const { values } = parseArgs({
        args,
        options: { from: { type: "string" }, to: { type: "string" }, out: { type: "string" } },
      });
      const time = z.iso.datetime({ offset: true }).transform(Date.parse);
      const { from, to, out } = z
        .object({ from: time, to: time, out: z.string().min(1) })
        .parse(values);
      if (
        await access(out).then(
          () => true,
          () => false,
        )
      )
        throw new Error(`${out} exists; choose a new file`);
      const rows = await workersLogs(await readToken())({ from, to });
      await writeFile(out, formatLogRows(rows), { flag: "wx" });
      return;
    }
    case "summary": {
      const { positionals } = parseArgs({ args, allowPositionals: true });
      const [path] = z.tuple([z.string().min(1)]).parse(positionals);
      console.log(JSON.stringify(summarize(parseLogRows(await readFile(path, "utf8"))), null, 2));
      return;
    }
    case "deploy": {
      const { values } = parseArgs({
        args,
        options: { ref: { type: "string" }, instance: { type: "string" } },
      });
      const request = z
        .object({ ref: z.string().min(1), instance: z.string().min(1) })
        .parse(values);
      const result = await deployStaging(request, {
        gh: async (argv) => {
          try {
            return (await promisify(execFile)("gh", argv, { timeout: 60_000 })).stdout;
          } catch (error) {
            const stderr = z.object({ stderr: z.string() }).safeParse(error);
            const reason = stderr.success ? stderr.data.stderr.trim().split("\n")[0] : undefined;
            throw new Error(`gh ${argv[0]} failed${reason ? `: ${reason}` : ""}`, {
              cause: error,
            });
          }
        },
        now: Date.now,
        sleep,
        report: console.error,
      });
      console.log(JSON.stringify(result));
      return;
    }
    case "cold": {
      parseArgs({ args });
      const result = await waitCold({
        query: workersLogs(await readToken()),
        now: Date.now,
        sleep,
        report: (v) => console.error(JSON.stringify(v)),
      });
      console.log(
        JSON.stringify({
          verdict: result.kind,
          exitAt: "exitAt" in result ? result.exitAt : null,
          checkedAt: Date.now(),
        }),
      );
      return;
    }
    default:
      throw new Error(
        "Usage: measure.ts logs --from <ISO time> --to <ISO time> --out <file> | summary <file> | deploy --ref <branch> --instance <type> | cold",
      );
  }
}

if (import.meta.main)
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Measurement failed");
    process.exitCode = 1;
  });
