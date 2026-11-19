export class V0SymbolError extends Error {}

type CrateRoot = { name: string; disambiguator: bigint; offset: number };

type Parser = {
  s: string;
  i: number;
  depth: number;
  roots: CrateRoot[];
};

const maxDepth = 500;
const basicTypes = new Set("abcdefhijlmnopstuvxyz");
export type RustSymbol = { owner: CrateRoot; pathCrates: ReadonlySet<string> };

export function v0Crates(symbol: string): RustSymbol {
  if (!symbol.startsWith("_R")) throw new V0SymbolError("not a v0 symbol");
  const p: Parser = { s: symbol.slice(2), i: 0, depth: 0, roots: [] };
  const owner = path(p);
  const pathCrates = new Set(p.roots.map((root) => root.name));
  if (p.i < p.s.length && /^[A-Z]/u.test(p.s.slice(p.i))) path(p);
  if (p.i < p.s.length && p.s[p.i] !== "." && p.s[p.i] !== "$") {
    throw fail(p, "trailing data");
  }
  if (owner === undefined) throw fail(p, "no defining crate root");
  return { owner, pathCrates };
}

function fail(p: Parser, message: string) {
  return new V0SymbolError(`${message} at offset ${p.i}`);
}

function peek(p: Parser) {
  return p.s[p.i];
}

function next(p: Parser) {
  const c = p.s[p.i];
  if (c === undefined) throw fail(p, "unexpected end");
  p.i++;
  return c;
}

function eat(p: Parser, c: string) {
  if (p.s[p.i] !== c) return false;
  p.i++;
  return true;
}

function nested<T>(p: Parser, body: () => T): T {
  if (++p.depth > maxDepth) throw fail(p, "nesting too deep");
  try {
    return body();
  } finally {
    p.depth--;
  }
}

function base62(p: Parser): bigint {
  if (eat(p, "_")) return 0n;
  let value = 0n;
  for (;;) {
    const c = next(p);
    if (c === "_") return value + 1n;
    const digit = /[0-9]/.test(c)
      ? c.charCodeAt(0) - 48
      : /[a-z]/.test(c)
        ? c.charCodeAt(0) - 97 + 10
        : /[A-Z]/.test(c)
          ? c.charCodeAt(0) - 65 + 36
          : -1;
    if (digit < 0) throw fail(p, `invalid base-62 digit ${c}`);
    value = value * 62n + BigInt(digit);
  }
}

function disambiguator(p: Parser): bigint {
  return eat(p, "s") ? base62(p) + 1n : 0n;
}

function decimal(p: Parser): number {
  const c = next(p);
  if (!/[0-9]/.test(c)) throw fail(p, "expected a decimal length");
  if (c === "0") return 0;
  let value = c.charCodeAt(0) - 48;
  while (/[0-9]/.test(peek(p) ?? "")) value = value * 10 + (next(p).charCodeAt(0) - 48);
  return value;
}

function ident(p: Parser): string {
  eat(p, "u");
  const length = decimal(p);
  eat(p, "_");
  const start = p.i;
  p.i += length;
  if (p.i > p.s.length) throw fail(p, "identifier runs past the end");
  return p.s.slice(start, p.i);
}

function backref<T>(p: Parser, parse: (p: Parser) => T): T {
  const start = p.i - 1;
  const target = base62(p);
  if (target >= BigInt(start)) throw fail(p, "backref does not point backwards");
  const resume = p.i;
  p.i = Number(target);
  const result = nested(p, () => parse(p));
  p.i = resume;
  return result;
}

function crateRoot(p: Parser, offset: number) {
  const dis = disambiguator(p);
  const name = ident(p);
  // rustc gives every real crate root a disambiguator (its stable crate id); a root
  // without one encodes a primitive with no single-letter code (f16, f128).
  if (dis === 0n) return;
  const root = { name, disambiguator: dis, offset };
  p.roots.push(root);
  return root;
}

function path(p: Parser): CrateRoot | undefined {
  return nested(p, () => {
    const offset = p.i;
    const tag = next(p);
    switch (tag) {
      case "C":
        return crateRoot(p, offset);
      case "M":
      case "X": {
        disambiguator(p);
        const owner = path(p);
        type(p);
        if (tag === "X") path(p);
        return owner;
      }
      case "Y":
        // A provided method is defined by the trait, even when Self belongs to another crate.
        type(p);
        return path(p);
      case "N": {
        const namespace = next(p);
        if (!/[A-Za-z]/u.test(namespace)) throw fail(p, "invalid namespace");
        const owner = path(p);
        disambiguator(p);
        ident(p);
        return owner;
      }
      case "I": {
        const owner = path(p);
        while (!eat(p, "E")) genericArg(p);
        return owner;
      }
      case "B":
        return backref(p, path);
      default:
        throw fail(p, `unexpected path tag ${tag}`);
    }
  });
}

function genericArg(p: Parser) {
  if (eat(p, "L")) base62(p);
  else if (eat(p, "K")) constant(p);
  else type(p);
}

function type(p: Parser): void {
  nested(p, () => {
    const tag = peek(p);
    if (tag === undefined) throw fail(p, "unexpected end in type");
    if (basicTypes.has(tag)) {
      p.i++;
      return;
    }
    switch (tag) {
      case "R":
      case "Q":
        p.i++;
        if (eat(p, "L")) base62(p);
        type(p);
        return;
      case "P":
      case "O":
      case "S":
        p.i++;
        type(p);
        return;
      case "A":
        p.i++;
        type(p);
        constant(p);
        return;
      case "T":
        p.i++;
        while (!eat(p, "E")) type(p);
        return;
      case "F":
        p.i++;
        if (eat(p, "G")) base62(p);
        eat(p, "U");
        if (eat(p, "K") && !eat(p, "C")) ident(p);
        while (!eat(p, "E")) type(p);
        type(p);
        return;
      case "D":
        p.i++;
        if (eat(p, "G")) base62(p);
        while (!eat(p, "E")) {
          path(p);
          while (eat(p, "p")) {
            ident(p);
            type(p);
          }
        }
        if (!eat(p, "L")) throw fail(p, "dyn type needs a lifetime");
        base62(p);
        return;
      case "B":
        p.i++;
        backref(p, type);
        return;
      case "C":
      case "M":
      case "X":
      case "Y":
      case "N":
      case "I":
        path(p);
        return;
      default:
        throw fail(p, `unexpected type tag ${tag}`);
    }
  });
}

function hexDigits(p: Parser) {
  while (!eat(p, "_")) {
    if (!/[0-9a-f]/.test(next(p))) throw fail(p, "invalid hex digit");
  }
}

function constant(p: Parser): void {
  nested(p, () => {
    const tag = next(p);
    switch (tag) {
      case "p":
        return;
      case "h":
      case "t":
      case "m":
      case "y":
      case "o":
      case "j":
      case "b":
      case "c":
      case "e":
        hexDigits(p);
        return;
      case "a":
      case "s":
      case "l":
      case "x":
      case "n":
      case "i":
        eat(p, "n");
        hexDigits(p);
        return;
      case "R":
        if (eat(p, "e")) hexDigits(p);
        else constant(p);
        return;
      case "Q":
        constant(p);
        return;
      case "A":
      case "T":
        while (!eat(p, "E")) constant(p);
        return;
      case "V": {
        path(p);
        const fields = next(p);
        if (fields === "T") while (!eat(p, "E")) constant(p);
        else if (fields === "S")
          while (!eat(p, "E")) {
            disambiguator(p);
            ident(p);
            constant(p);
          }
        else if (fields !== "U") throw fail(p, "invalid const fields");
        return;
      }
      case "B":
        backref(p, constant);
        return;
      default:
        throw fail(p, `unexpected const tag ${tag}`);
    }
  });
}
