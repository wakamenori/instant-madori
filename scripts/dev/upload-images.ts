import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";

const imagesRef = "refs/heads/images";
const repository = "https://github.com/wakamenori/instant-madori";
const maxAttempts = 10;
const maxImageBytes = 10 * 1024 ** 2;
const usage = `Usage: pnpm images:upload --issue <number> <image>...
Add images to issue-<number>/ on origin's append-only images branch and print Markdown
pinned to the adding commit. The current branch, index and worktree stay unchanged.
A PR uses the number of the Issue it closes. Names use lowercase letters and digits
joined by single - _ or . with a png, jpg, jpeg, gif or webp extension, at most 100
characters. Images must be 1 byte to 10 MiB. Rerunning is safe.
Never upload an image that shows a secret value.`;

const signatures: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
  png: (bytes) => startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: (bytes) => startsWith(bytes, 0, [0xff, 0xd8, 0xff]),
  jpeg: (bytes) => startsWith(bytes, 0, [0xff, 0xd8, 0xff]),
  gif: (bytes) => ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"),
  webp: (bytes) => ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP"),
};
const issueSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,6}$/u)
  .brand<"IssueNumber">();
const nameSchema = z
  .string()
  .regex(new RegExp(`^[a-z0-9]+(?:[._-][a-z0-9]+)*\\.(${Object.keys(signatures).join("|")})$`, "u"))
  .brand<"ImageName">();
const objectSchema = z
  .string()
  .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u)
  .brand<"ObjectId">();
type IssueNumber = z.infer<typeof issueSchema>;
type ImageName = z.infer<typeof nameSchema>;
type ObjectId = z.infer<typeof objectSchema>;

interface Image {
  readonly name: ImageName;
  readonly stem: string;
  readonly blob: ObjectId;
}
interface Origin {
  readonly fetchUrl: string;
  readonly pushUrl: string;
}
interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: ObjectId;
  readonly name: string;
}
interface Snapshot {
  readonly tip: ObjectId;
  readonly root: ReadonlyMap<string, TreeEntry>;
  readonly folder: ReadonlyMap<string, TreeEntry>;
}
type Plan =
  | { readonly kind: "present" }
  | { readonly kind: "add"; readonly images: readonly Image[] }
  | { readonly kind: "edited"; readonly names: readonly ImageName[] };
interface Placement {
  readonly image: Image;
  readonly commit: ObjectId;
  readonly added: boolean;
}

function parseCommand(argv: string[], baseDir: string) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      issue: { type: "string", multiple: true },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  const [issue, ...extra] = values.issue ?? [];
  const parsed = issueSchema.safeParse(issue);
  if (!parsed.success || extra.length > 0) {
    throw new Error("Use --issue exactly once with a number from 1 to 9999999");
  }
  if (positionals.length === 0) throw new Error("Provide at least one image path");
  return { issue: parsed.data, files: positionals.map((path) => resolve(baseDir, path)) };
}

function readImage(path: string) {
  const localName = basename(path);
  if (!nameSchema.safeParse(localName).success || localName.length > 100) {
    throw new Error(`${localName}: use a lowercase image name of at most 100 characters`);
  }
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`${path}: not a regular file`);
  if (stat.size === 0 || stat.size > maxImageBytes) {
    throw new Error(`${localName}: image size must be 1 byte to 10 MiB`);
  }
  const bytes = readFileSync(path);
  const extension = extname(localName).slice(1);
  if (!signatures[extension]?.(bytes)) {
    throw new Error(`${localName}: content is not a ${extension} image`);
  }
  return { bytes, extension, stem: basename(localName, `.${extension}`) };
}

function git(args: readonly string[], input?: Uint8Array, network = false) {
  const result = spawnSync("git", args, {
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 ** 2,
    ...(network ? { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } } : {}),
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function gitOk(args: readonly string[], input?: Uint8Array, network = false): string {
  const result = git(args, input, network);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed:\n${result.stderr}`);
  return result.stdout.trim();
}

function remoteTip(origin: Origin): ObjectId {
  const result = git(["ls-remote", "--exit-code", origin.fetchUrl, imagesRef], undefined, true);
  if (result.status === 2) {
    throw new Error("origin has no images branch. Tell the operator; nothing was pushed.");
  }
  if (result.status !== 0) throw new Error(`Reading images failed:\n${result.stderr}`);
  for (const line of result.stdout.split("\n")) {
    const [oid, ref] = line.split("\t");
    if (ref === imagesRef) return objectSchema.parse(oid);
  }
  throw new Error("origin did not advertise refs/heads/images");
}

function readTree(tree: ObjectId): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const entry of gitOk(["ls-tree", "-z", tree]).split("\0")) {
    if (!entry) continue;
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t(.*)$/su.exec(entry);
    if (!match) throw new Error(`Invalid tree entry in ${tree}`);
    const [, mode, type, oid, name] = match;
    if (!mode || !type || !name || entries.has(name)) {
      throw new Error(`Invalid or duplicate tree entry in ${tree}`);
    }
    entries.set(name, { mode, type, oid: objectSchema.parse(oid), name });
  }
  return entries;
}

function readSnapshot(origin: Origin, tip: ObjectId, issue: IssueNumber): Snapshot {
  if (git(["cat-file", "-e", `${tip}^{commit}`]).status !== 0) {
    gitOk(
      [
        "fetch",
        "--no-write-fetch-head",
        "--no-tags",
        "--no-prune",
        "--no-recurse-submodules",
        "--no-auto-maintenance",
        "--no-write-commit-graph",
        origin.fetchUrl,
        imagesRef,
      ],
      undefined,
      true,
    );
    if (git(["cat-file", "-e", `${tip}^{commit}`]).status !== 0) {
      throw new Error("images was rewritten. Tell the operator; nothing was pushed.");
    }
  }
  for (const rootId of gitOk(["rev-list", "--max-parents=0", tip]).split("\n")) {
    for (const entry of readTree(objectSchema.parse(rootId)).values()) {
      if (entry.type !== "tree" || !/^issue-[1-9][0-9]*$/u.test(entry.name)) {
        throw new Error(
          "images contains another branch's history. Tell the operator; nothing was pushed.",
        );
      }
    }
  }
  const root = readTree(tip);
  const folder = root.get(`issue-${issue}`);
  if (folder && folder.type !== "tree") throw new Error(`issue-${issue} is not a folder`);
  return { tip, root, folder: folder ? readTree(folder.oid) : new Map() };
}

function planUpload(folder: Snapshot["folder"], images: readonly Image[]): Plan {
  const edited = images.filter((image) => {
    const entry = folder.get(image.name);
    return entry && (entry.type !== "blob" || entry.oid !== image.blob);
  });
  if (edited.length > 0) return { kind: "edited", names: edited.map((image) => image.name) };
  const missing = images.filter((image) => !folder.has(image.name));
  return missing.length === 0 ? { kind: "present" } : { kind: "add", images: missing };
}

function writeTree(entries: ReadonlyMap<string, TreeEntry>): ObjectId {
  const input = [...entries.values()]
    .map(({ mode, type, oid, name }) => `${mode} ${type} ${oid}\t${name}\0`)
    .join("");
  return objectSchema.parse(gitOk(["mktree", "-z"], Buffer.from(input)));
}

function writeCommit(snapshot: Snapshot, issue: IssueNumber, images: readonly Image[]): ObjectId {
  const folder = new Map(snapshot.folder);
  for (const image of images) {
    folder.set(image.name, { mode: "100644", type: "blob", oid: image.blob, name: image.name });
  }
  const name = `issue-${issue}`;
  const root = new Map(snapshot.root);
  root.set(name, { mode: "040000", type: "tree", oid: writeTree(folder), name });
  return objectSchema.parse(
    gitOk([
      "commit-tree",
      writeTree(root),
      "-p",
      snapshot.tip,
      "-m",
      `docs(images): add images to ${name}`,
      "-m",
      images.map((image) => `${name}/${image.name}`).join("\n"),
    ]),
  );
}

function addedBy(tip: ObjectId, issue: IssueNumber, name: ImageName): ObjectId {
  return objectSchema.parse(gitOk(["rev-list", "-n", "1", tip, "--", `issue-${issue}/${name}`]));
}

async function upload(
  origin: Origin,
  issue: IssueNumber,
  images: readonly Image[],
): Promise<Placement[]> {
  let tip = remoteTip(origin);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const snapshot = readSnapshot(origin, tip, issue);
    const plan = planUpload(snapshot.folder, images);
    switch (plan.kind) {
      case "edited":
        throw new Error(
          `${plan.names.map((name) => `issue-${issue}/${name}`).join(", ")} already exists with different bytes. Nothing was pushed.`,
        );
      case "present":
        return images.map((image) => ({
          image,
          commit: addedBy(tip, issue, image.name),
          added: false,
        }));
      case "add": {
        const commit = writeCommit(snapshot, issue, plan.images);
        const result = git(
          [
            "push",
            "--porcelain",
            "--no-verify",
            "--no-follow-tags",
            origin.pushUrl,
            `${commit}:${imagesRef}`,
          ],
          undefined,
          true,
        );
        if (result.status === 0) {
          const added = new Set(plan.images.map((image) => image.name));
          return images.map((image) => ({
            image,
            commit: added.has(image.name) ? commit : addedBy(tip, issue, image.name),
            added: added.has(image.name),
          }));
        }
        let next = remoteTip(origin);
        // A rival can still hold the remote ref lock after our push has been refused.
        for (const delay of [1000, 2000]) {
          if (next !== tip) break;
          await setTimeout(delay);
          next = remoteTip(origin);
        }
        if (next === tip)
          throw new Error(`Push to images failed:\n${result.stdout}${result.stderr}`);
        if (attempt < maxAttempts) {
          process.stderr.write(
            `images moved to ${next.slice(0, 12)}; re-stacking (attempt ${attempt + 1} of ${maxAttempts})\n`,
          );
        }
        tip = next;
        break;
      }
    }
  }
  throw new Error(
    "images kept moving: 10 other uploads landed during this run. Rerun the same command; it is safe.",
  );
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2), process.env["INIT_CWD"] ?? process.cwd());
  if (command === "help") {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const locals = command.files.map(readImage);
  const origin = {
    fetchUrl: gitOk(["remote", "get-url", "origin"]),
    pushUrl: gitOk(["remote", "get-url", "--push", "origin"]),
  };
  const images = locals.map(({ bytes, extension, stem }): Image => {
    const blob = objectSchema.parse(gitOk(["hash-object", "-w", "--stdin"], bytes));
    return { blob, stem, name: nameSchema.parse(`${stem}-${blob.slice(0, 12)}.${extension}`) };
  });
  const unique = new Map(images.map((image) => [image.name, image]));
  const placements = await upload(origin, command.issue, [...unique.values()]);
  const links = new Map<ImageName, string>();
  for (const { image, commit, added } of placements) {
    const path = `issue-${command.issue}/${image.name}`;
    process.stderr.write(
      `${added ? "added" : "reused"} ${path} ${added ? "in" : "from"} ${commit.slice(0, 12)}\n`,
    );
    links.set(image.name, `![${image.stem}](${repository}/blob/${commit}/${path}?raw=true)`);
  }
  process.stdout.write(`${images.map((image) => links.get(image.name)).join("\n")}\n`);
}

function startsWith(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  return startsWith(
    bytes,
    offset,
    [...value].map((character) => character.charCodeAt(0)),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Image upload failed"}\n`);
    process.exitCode = 1;
  }
}
