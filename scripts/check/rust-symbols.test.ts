import assert from "node:assert/strict";
import { test } from "node:test";
import { v0Crates, V0SymbolError } from "./rust-symbols.ts";

function crates(symbol: string) {
  const { owner, pathCrates } = v0Crates(symbol);
  return { crate: owner.name, mentioned: [...pathCrates].sort() };
}

const cases: [string, string, { crate: string; mentioned: string[] }][] = [
  [
    "an identifier that starts with _ keeps its separator out of the name",
    "_RNvCs5fGHjzWXRav_7___rustc12___rust_alloc",
    { crate: "__rustc", mentioned: ["__rustc"] },
  ],
  [
    "an instantiating-crate suffix and a vendor suffix follow the path",
    "_RNvMs5_NtCs5JHfeWeQK0x_5alloc7raw_vecNtB5_11RawVecInner11finish_growCsdaTYTjkd8XF_9solidcore.llvm.12542934454564879836",
    { crate: "alloc", mentioned: ["alloc"] },
  ],
  [
    "an array type with a const length and a backref",
    "_RNvMs4_NtCs5JHfeWeQK0x_5alloc7raw_vecINtB5_6RawVecANtNtCsdaTYTjkd8XF_9solidcore8topology6FaceIdj2_E8grow_oneBR_",
    { crate: "alloc", mentioned: ["alloc", "solidcore"] },
  ],
  [
    "nested closures with disambiguated empty names",
    "_RNCNCNvMsf_NtCsjCn0e6YyiYx_13madori_viewer3gpuNtB9_6Viewer6create0s1_0Bb_.llvm.11198792627237899243",
    { crate: "madori_viewer", mentioned: ["madori_viewer"] },
  ],
  [
    "a provided trait method starts with its self type",
    "_RNvYNCNvMsm_NtCsbnZiOa0PDpC_23solidcraft_viewport_gpu4viewNtBa_8Renderer4drawsc_0INtNtNtCs4NIexwV1FGX_4core3ops8function6FnOnceTRNtBa_3CutEE9call_onceBc_",
    { crate: "core", mentioned: ["core", "solidcraft_viewport_gpu"] },
  ],
  [
    "a C followed by digits inside an impl disambiguator is not a crate root",
    "_RNvMsC3_NtCs1_4core3fmtNtNtCs1_4core3fmt9Formatter3pad",
    { crate: "core", mentioned: ["core"] },
  ],
  [
    "KC in a fn type is the C ABI, not a crate root",
    "_RNvYFKCjEuNtNtCs1_4core3fmt5Debug3fmt",
    { crate: "core", mentioned: ["core"] },
  ],
  [
    "a crate root without a disambiguator encodes f16, not a crate",
    "_RNvYC3f16NtNtCs1_4core3fmt5Debug3fmt",
    { crate: "core", mentioned: ["core"] },
  ],
];

for (const [label, symbol, expected] of cases) {
  void test(`v0: ${label}`, () => {
    assert.deepEqual(crates(symbol), expected);
  });
}

for (const symbol of ["_RNvC", "_RNvCs1_4co", "_RNvB_3foo", "_RZ", "_RNvCs1_4core3fooX"]) {
  void test(`v0: rejects ${symbol}`, () => {
    assert.throws(() => crates(symbol), V0SymbolError);
  });
}

for (const [symbol, owner] of [
  ["_RNvYNtCs3_9solidcore4IterNtNtCs2_4core4iter8Iterator4fold", "core"],
  ["_RNvYNtCs2_4core3FooNtCs3_9solidcore8Evaluate8evaluate", "solidcore"],
] as const) {
  void test(`Y paths attribute the body to ${owner}`, () => {
    assert.equal(v0Crates(symbol).owner.name, owner);
  });
}

void test("the crate disambiguator is decoded as the demangled crate hash", () => {
  assert.equal(v0Crates("_RNvCs1_13madori_viewer6render").owner.disambiguator, 3n);
});
