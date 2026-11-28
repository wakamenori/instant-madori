import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const installed = Symbol.for("madori.markdown-reads");

function pathArgument(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString();
  if (value instanceof URL && value.protocol === "file:") {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function installRecorder(record: string) {
  if (Reflect.has(globalThis, installed)) return;
  Reflect.set(globalThis, installed, true);
  const entry = process.argv[1];
  const reader = process.env.MADORI_MARKDOWN_READER ?? (entry && relative(root, entry));
  if (!reader) return;
  if (process.env.NODE_TEST_CONTEXT !== undefined) process.env.MADORI_MARKDOWN_READER = reader;

  function recordRead<Operation extends (...args: never[]) => unknown>(operation: Operation) {
    return new Proxy(operation, {
      apply(target, receiver: unknown, args: unknown[]): unknown {
        const filename = pathArgument(args[0]);
        if (filename !== undefined) {
          const path = relative(root, resolve(filename));
          const segments = path.split(sep);
          if (
            segments[0] !== ".." &&
            !isAbsolute(path) &&
            !segments.includes("node_modules") &&
            path.endsWith(".md")
          ) {
            fs.appendFileSync(record, JSON.stringify({ reader, path }) + "\n");
          }
        }
        return Reflect.apply(target, receiver, args);
      },
    });
  }

  fs.readFileSync = recordRead(fs.readFileSync);
  fs.openSync = recordRead(fs.openSync);
  fs.readFile = recordRead(fs.readFile);
  fs.open = recordRead(fs.open);
  fs.openAsBlob = recordRead(fs.openAsBlob);
  fs.createReadStream = recordRead(fs.createReadStream);
  fs.copyFileSync = recordRead(fs.copyFileSync);
  fs.copyFile = recordRead(fs.copyFile);
  fs.cpSync = recordRead(fs.cpSync);
  fs.cp = recordRead(fs.cp);
  fs.promises.readFile = recordRead(fs.promises.readFile);
  fs.promises.open = recordRead(fs.promises.open);
  fs.promises.copyFile = recordRead(fs.promises.copyFile);
  fs.promises.cp = recordRead(fs.promises.cp);
  syncBuiltinESMExports();
}

const record = process.env.MADORI_MARKDOWN_READS;
if (record) installRecorder(record);
