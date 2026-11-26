# Candidate 2: pattern display design for instant-madori (#173)

**Summary.** The design has five parts:
- **Route B.** Patterns are drawn inside viewport-gpu's own opaque shader, keyed by palette index. The vertex format does not change.
- **Frames from modeling.** Modeling computes one planar or box frame per face at export. The frames are anchored to world (or object) lattices, use f64, and have their origin snapped near the house.
- **Mips stored with the image.** The Container is the only place a photo is decoded. It writes one JPEG holding the full mip chain side by side (a "mip atlas"), with the mips averaged in linear light.
- **No decoder in the wasm.** The browser decodes the stored JPEG with its own decoder and hands RGBA bytes to the wasm.
- **No mip pass in the viewer.**

I made no changes to the repository.

---

## Problem

The viewer draws faces through SolidCraft's `Renderer`. That renderer has no UVs, no tiling textures and no mip support. Five constraints shape the design:
1. **Glass breaks a viewer-owned pass.** One see-through body moves the whole frame offscreen. The viewer's depth buffer then stays at far, so any pass the viewer draws itself ("route A") shows patterns through walls (`view.rs:4635`, `4717`, `3443`). This is latent today, but faded storeys, glass and sun shadows will all set it off.
2. **The triangle vertex has no spare word** (`TRI_SIZE = 32`). Widening it touches about 10 vgpu functions and 14 ui-egui files.
3. **TFAC face numbers are per artifact.** Frames can live inside one MDSP but never in housing data.
4. **Plan §5.2** says the Worker never decodes images, and the server does not trust images the UI processed.
5. **Plan §4.3** says the Container returns bytes and only the Worker writes R2.

Also, lighting runs on sRGB-coded values, so texels must reach `lit_color` sRGB-coded.

## Usage (caller's view)

**README excerpt (for #176, #179 and #181).**

> A patterned face is a face in MDSP with a `FPRJ` record. The record holds a material (a pattern key) and a projection in world millimetres. Modeling writes it; nothing else computes frames. The viewer reports which pattern keys it is missing. The web fetches each key once, decodes it with the browser and calls `put_pattern`. Until a pattern arrives, its faces show their FCOL colour, and so does any viewer that doesn't know these sections.

**Call site 1: modeling export (#176)**, in `crates/modeling/src/display.rs`.
```rust
let surfaces = surface::resolve(&house, &model, &meshes)?;   // Err if an assignment doesn't resolve to a face (plan §3.5)
let display = DisplayModel::new(bodies)?.with_surfaces(surfaces)?;
```

**Call site 2: Worker job step (#179)**, run before `render snapshot`. It is idempotent.
```ts
for (const key of patternKeysOf(input.house)) await ensurePattern(env, owner, key); // Container makes bytes → R2 putNew → D1 insert-or-ignore
```

**Call site 3: web and viewer (#181).**
```ts
const summary = viewer.show(bytes);                       // draws now; patterned faces start with FCOL
for (const key of summary.missingPatterns)                // e.g. "p1-3fa9…"
  patterns.load(key).then(rgba => { viewer.put_pattern(key, rgba); session.requestDraw(); });
// patterns.load: Map<key, Promise<Uint8Array>>; GET /api/patterns/p1/<sha> → createImageBitmap → OffscreenCanvas → getImageData
```

## Shape

### Data types (`crates/display`: no dependencies, shared by the writer and the reader)

```rust
// crates/display/src/pattern.rs — the recipe contract between the Container (writer) and the viewer (reader)
pub struct Sha256(pub [u8; 32]);
#[repr(u16)] pub enum PatternRecipe { V1 = 1 }            // every input that changes output bytes bumps this
pub struct PatternKey { pub recipe: PatternRecipe, pub source: Sha256 } // source = SHA-256 of the ORIGINAL asset
impl PatternKey { pub fn parse(s: &str) -> Result<Self, DisplayError> { todo!() } pub fn to_string(&self) -> String { todo!() } }
/// V1: level 0 is 1024², levels 1..=10 stacked at x=1024. The atlas is 1536×1024. Each level of 16 px or more starts on a 16-px block.
pub struct AtlasLayout;
impl AtlasLayout {
    pub const EDGE: u32 = 1024; pub const LEVELS: u32 = 11; pub const WIDTH: u32 = 1536; pub const HEIGHT: u32 = 1024;
    pub fn level_rect(level: u32) -> Option<[u32; 4]> { todo!() } // x, y, w, h
}

// crates/display/src/model/surface.rs
pub struct MaterialId(u16);
/// u and v are one repeat each (mm), orthogonal, length 0.1..=1e6, finite. Origin is a lattice point near the house.
pub struct PlanarFrame { origin: [f32; 3], u: [f32; 3], v: [f32; 3] }
impl PlanarFrame { pub fn new(origin: [f32;3], u: [f32;3], v: [f32;3]) -> Result<Self, DisplayError> { todo!() } }
pub enum Projection { Planar(PlanarFrame), /// The third axis is w = normalize(u×v)·|u|. Used for non-planar faces.
                      Box(PlanarFrame) }
pub struct FaceSurface { pub body: u32, pub face: u32, pub material: MaterialId, pub projection: Projection }
/// Materials are sorted and unique by key, and each one is referenced. Faces are sorted and unique by (body, face). Each face exists in that body's TFAC.
pub struct Surfaces { materials: Vec<PatternKey>, faces: Vec<FaceSurface> }
impl Surfaces { pub fn new(materials: Vec<PatternKey>, faces: Vec<FaceSurface>) -> Result<Self, DisplayError> { todo!() } }
impl DisplayModel {
    pub fn with_surfaces(self, s: Surfaces) -> Result<Self, DisplayError> { todo!() } // checks body and face references
    pub fn surfaces(&self) -> Option<&Surfaces> { todo!() }
}
```

**MDSP: two known optional sections, both flag 0, added to `KNOWN_OPTIONAL_KINDS` after #126's storey section.**
- `MATL`: a u32 count, then 36-byte records: `source[32]`, `recipe u16`, `reserved u16 = 0`. Sorted by key.
- `FPRJ`: a u32 count, then 48-byte records: `body u32`, `face u32`, `material u16`, `kind u8` (0 planar, 1 box), `reserved u8 = 0`, then `origin f32×3`, `u f32×3`, `v f32×3`. Sorted by (body, face).

Validation and canonical form:
- `FPRJ` without `MATL` is rejected. So is a `MATL` entry that nothing references, a reserved byte that isn't 0, a non-finite value, a degenerate or skewed frame, or a reference to a missing body, face or material.
- Decoding still ends with the re-encode comparison.
- There is no base colour in `MATL`. FCOL is the single source of truth for the fallback and base colour, and modeling writes the material's housing colour there.

**Size for a large house.** About 4,000 patterned faces × 48 B ≈ 190 KB, plus about 50 × 36 B for materials. That is about 1.2 % of 16 MiB. Per-vertex UVs at about 300k patterned vertices × 8 B would be about 2.4 MB.

### Coordinate rule (owned by modeling alone, computed in f64 at export)

`crates/modeling/src/model/surface.rs` holds pure functions:

```rust
pub(crate) struct Lattice { anchor: DVec3, u: DVec3, v: DVec3 }               // one repeat per axis
pub(crate) fn wall_lattice(side_normal: DVec3, storey_base_z: f64, m: &MaterialRow) -> Lattice { todo!() }
pub(crate) fn floor_lattice(top_z: f64, m: &MaterialRow) -> Lattice { todo!() }   // ceilings: same, with v flipped so the image isn't mirrored from below
pub(crate) fn object_lattice(placement: &ObjectFrame, face_normal_local: DVec3, m: &MaterialRow) -> Lattice { todo!() }
pub(crate) fn snap(l: &Lattice, near: DVec3) -> PlanarFrame { todo!() }         // anchor + round(k_u)·u + round(k_v)·v; the image is unchanged
pub(crate) fn resolve(house: &House, model: &Model, meshes: &[Mesh]) -> Result<Surfaces, ExportError> { todo!() }
```

**Walls (either side).**
- The axes are `û = normalize(Z × n)` and `v̂ = Z`. The material angle rotates both within the face plane.
- The anchor is `(0, 0, storey_base_z)`.
- `û` comes from the face normal, not from the boundary's start→end direction. So a future split or merge can't flip it, and u points right as seen from the front.
- Moving a wall shifts it perpendicular to û, so `dot(p, û)` doesn't change.
- A stretched neighbour keeps its tiles fixed in the world, so tile size holds.
- Collinear pieces of a split share n and the anchor, which gives the same lattice, so tiles stay continuous.

**Floors.**
- World XY, rotated by the material angle. The anchor is the slab top z.
- Rooms on the same storey with the same material flow continuously across doorways.

**Furniture and objects.**
- The lattice is in the object's own frame (its placement point and rotation), so grain moves and turns with the object.
- For a planar face, the projection plane is the one picked by the face's dominant object-local axis.

**Non-planar faces** (cylinder legs, arch soffits):
- Modeling classifies a face as non-planar when its triangle normals disagree by more than 1e-3. It then writes `kind = Box` in the same wall or object frame.
- The shader blends three projections. Grain along v stays vertical on legs.
- The rule is encoded once per face, in `FPRJ`.

**Snapping.**
- The origin snaps to the lattice point nearest the house's bounding-box centre.
- This keeps magnitudes small, and faces that share a plane, material and angle get identical frames. Identical frames share one palette entry.

**Where each invariant is checked:**
- **Housing** validates the material row: repeat 1–10,000 mm, finite angle, and an owned asset (the Worker checks ownership).
- **Modeling** fails the export if an assignment doesn't resolve to a face.
- **Display** checks the structure.
- **The viewer** trusts the types.

### Rendering: route B, the local patch (and the public surface it adds)

```rust
// solidcraft-viewport/src/scene.rs
pub struct FaceMap { pub layer: u16, pub projection: MapProjection }
pub enum MapProjection { Planar { origin: [f32;3], u: [f32;3], v: [f32;3] }, Box { origin: [f32;3], u: [f32;3], v: [f32;3] } }
pub struct SceneMesh { /* existing */ pub face_maps: Vec<(u32, FaceMap)> }   // empty = today's look

// solidcraft-viewport-gpu
pub struct SurfaceMaps { /* D2Array Rgba8UnormSrgb, edge, layers, full mips */ }
impl SurfaceMaps {
    pub fn new(device: &wgpu::Device, edge: u32, levels: u32, layers: u32) -> Result<Self, MapError> { todo!() }
    pub fn write_layer(&self, queue: &wgpu::Queue, layer: u16, level: u32, rgba: &[u8]) -> Result<(), MapError> { todo!() }
    pub fn grow(&mut self, device: &wgpu::Device, encoder: &mut wgpu::CommandEncoder, layers: u32) -> Result<(), MapError> { todo!() }
}
impl Renderer { pub fn set_surface_maps(&mut self, device: &wgpu::Device, maps: Option<&SurfaceMaps>) { todo!() } } // None → 1×1 white stand-in
```

**Data path.**
- `scene_geometry` interns palette entries by (rgba, map). That gives patterned faces their own palette indices; the limit is `MAX_PALETTE = 2²⁰`.
- It writes a map-row texture parallel to the palette, following the `material_texture` pattern. Each entry is three `Rgba32Float` texels: origin plus kind, u plus layer, and v.

**Shader.**
- A flat palette index goes through `TOut` and `FOut`.
- At the top of `solid()`, before `clipped()`, the shader always computes the uv and its derivatives (`dpdx` and `dpdy`).
- It then samples with `textureSampleGrad` inside the kind branch. Explicit gradients are legal in non-uniform control flow and are FXC-safe.
- The texel decodes from sRGB in hardware, then the shader re-encodes it to sRGB and hands it to `lit()` in place of the palette base colour.
- AO, OIT, cut pipelines and every future lighting term apply to patterned faces automatically.

**Sampler.** Repeat, linear for all filters, and `anisotropy_clamp = 8`.

**Upstream.** Offer the Planar half upstream once it has stabilised locally. It fills the raster gap noted at `render-runtime-textures.md:33`, and its frame convention matches `PlanarFrame`. Keep Box local unless upstream wants it.

**Recording the patch.** List every changed file in `localPatches`, give the reason in `solidcraft.md` 独自変更, and keep upstream, local and service changes in separate commits.

### Viewer (`crates/viewer/src/patterns.rs`)

```rust
pub(crate) struct PatternCache { maps: SurfaceMaps, slots: Vec<Option<(PatternKey, u64 /*last use*/)>>, max_layers: u32 }
impl PatternCache {
    pub fn layer_of(&mut self, key: &PatternKey) -> Option<u16> { todo!() }
    pub fn insert(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, key: PatternKey, atlas_rgba: &[u8], pinned: &[PatternKey]) -> Result<u16, ViewerFailure> { todo!() }
    // TODO: check len == WIDTH*HEIGHT*4; slice each AtlasLayout::level_rect into write_layer;
    //       evict the LRU slot not in `pinned`; else grow 4→8→16→32 (capped by the adapter's max_texture_array_layers); else Err(PatternCacheFull)
}
#[wasm_bindgen] impl Viewer {
    pub fn show(&mut self, bytes: &[u8]) -> Result<DisplaySummary, ViewerFailure> { todo!() } // summary.missing_patterns: Vec<String>
    pub fn put_pattern(&mut self, key: &str, atlas_rgba: &[u8]) -> Result<(), ViewerFailure> { todo!() } // then rebuilds face_maps and the scene
}
```

- The cache survives `show`, so switching plans doesn't refetch or re-upload.
- A pattern that can't be resident (cache full) falls back to FCOL, and the summary reports it.

### Image flow

1. **Container (new crate `crates/pattern`).**
   - Deps: `image` (jpeg, png), `moxcms`, `madori-display`. A new boundary row in `boundaries.ts` limits it to those, with no GPU.
   - It decodes with the §5.2 limits applied again, applies EXIF orientation, converts an ICC profile to sRGB (P3 photos), and resizes to 1024² in linear light. The frame's u and v restore the real aspect ratio.
   - It builds the mips with floor-halved area averaging in linear light. A dev-dependency oracle test compares them against solidcraft-render's `MipChain`.
   - It packs the atlas and encodes it as JPEG 4:4:4 at q90 (about 0.5 MB).
   - Route: `POST /v1/patterns` in the geometry-api route table. Request: up to 7.5 MB of PNG or JPEG. Response: `image/jpeg`, up to 4 MiB.
2. **Worker.**
   - `ensurePattern` looks up D1 `asset_patterns(owner, recipe, source_sha256 → r2_key, bytes, sha256)`.
   - On a miss it reads the original from R2, calls the Container, then does `putNew` at `owners/<o>/patterns/<recipe>/<source_sha>.jpg`. On a conflict it accepts the existing object. Then it runs `INSERT OR IGNORE`.
   - Run twice or after a crash, it ends in the same state.
3. **Delivery.**
   - `GET /api/patterns/:recipe/:sha256` checks the owner's row (the same check as #158) and returns `image/jpeg`.
   - It stays `no-store`, so plan §4.7 is unchanged.
4. **Web.**
   - `createImageBitmap(blob, {imageOrientation:"none", colorSpaceConversion:"none"})`, then OffscreenCanvas `getImageData`, then RGBA bytes.
   - Orientation is already applied, so "none" gives the same result in every browser.
   - Bytes avoid wgpu's `.unwrap()` in `copy_external_image_to_texture`. With bytes, a browser exception can't abort the wasm.

**Cache units:**

| Layer | Unit | Key |
|---|---|---|
| R2 | one object per owner, recipe and original | `(recipe, source)` |
| Web | one promise per key for the page's lifetime | `(recipe, source)` |
| GPU | one array layer per key, LRU | `(recipe, source)` |

### Sun shadows (§6.5)

- **Live shadow map.** Route B can host it as a light-space depth pass modelled on the `ao.rs` `OpaquePipelines`. It would take a separate caster list (which includes hidden roofs), bind the map in group 2, and multiply the term in at `lit(i, occlusion(i) * sun(i))`. Floors, walls, ceilings and patterned faces all receive it, because they share `lit`.
- **Baked mask (second option).** The same per-palette frame rows could carry a precomputed sun mask as a second array channel. That suits §4.8's "cache results by plan ID plus conditions": the result is data, and thin slits can be computed analytically.

## Tradeoffs accepted

- We carry a local patch on two shared upstream crates, with merge conflicts in `view.rs`. In exchange, glass and offscreen rendering are correct, there is one lighting path, and shadows have a home.
- Patterned faces cost a palette entry each, partly shared through snapped frames. In exchange, the vertex format is untouched.
- Box projection blurs grain where the three projections blend on legs and arches. In exchange, the export doesn't do cylindrical unwrapping.
- Stored mips cost about 33 % more bytes per pattern. In exchange, the wasm has no image or mip code, and filtering is done once in linear light.
- A fixed 1024² square (needed for the texture array) gives up some resolution along the long axis of a strongly rectangular repeat.
- With no HTTP cache, a page reload refetches each pattern. In exchange, the per-user no-store rule stays intact.
- Phase is world-anchored, so a wall doesn't necessarily start on a full tile. In exchange, tiles hold through moves, stretches and splits together.

## Alternatives considered

- **Per-vertex UVs computed at export.** I took this seriously:
  - It wins on f64 precision and on true cylindrical unwrapping for legs and arches.
  - Under B it needs a vertex slot. That means widening `TRI_SIZE` (the large ripple above) or packing a u16×2 UV into the analysis `value` word, which overloads its meaning and gives about 1/256-repeat precision.
  - Under A it is easy, but A is wrong with any transparency.
  - It costs about 10× the MDSP bytes.
  - Rejected. It would flip only if the box projection looks unacceptable and A's depth problem were solved.
- **Route A, a viewer-owned pass.** It needs no upstream patch. But patterns show through walls on the offscreen path, glass is composited in the wrong order, faces are drawn twice, and shadows would have to be reimplemented. Rejected.
- **Image pipeline in the browser.**
  - Making the stored derivative in the browser: rejected, because §5.2 says the server doesn't trust UI processing, and "once per original" needs one deterministic implementation.
  - Decoding originals at view time: rejected, because it means up to 7.5 MB per material every session.
  - I do adopt the browser's native decoder for the already-normalised derivative.
- **Mips made in the viewer:**
  - A wasm CPU pass: rejected because of the code size and main-thread time.
  - A GPU downsample pass: viable, but it adds a pipeline and only handles power-of-two sizes correctly.
  - I rejected both in favour of storing mips with the image.
- **The viewer derives frames from normals plus anchors.** This puts the rule in two places. Rejected.
- **Sending `ImageBitmap` to the wasm** (`copy_external_image_to_texture` per level, with a sub-rect origin): it is faster, but a browser exception panics the wasm. I keep it in reserve (see the observations below).

## Prototype observations that would change this design

1. **Frame time.** If B at 8×8 rooms costs more than about 2 ms or 15 % per frame over plain colour on T3 Chromium, I'd first check that unpatterned faces skip the sample, then drop anisotropy to 4. If it is still slow, I'd look again at A's double draw.
2. **Glass in A.** If A's `glass` toggle shows correct occlusion (that is, the viewer's depth does hold model depth), A becomes viable and per-vertex UVs return as an option.
3. **Wasm size.** If B adds more than about 30 KB brotli to the release wasm, I'd look for what got pulled in. The design adds no decoder.
4. **Scene upload.** If `scene_geometry` with per-face palette entries takes noticeably longer to upload for a large house, I'd make frame sharing stronger (snap per storey).
5. **`getImageData` time.** If decoding the 1536×1024 atlas takes more than about 30 ms on the main thread, I'd switch to the `ImageBitmap` path and validate the size in Rust before the copy.
6. **JPEG bleed.** If the small mip levels in the atlas show bleed or seams, I'd store the levels below 16 px as PNG or drop them.
7. **Box projection on legs.** If box blending on the `room` legs or arches looks bad in screenshots, I'd add a `kind = 2` cylindrical frame in `FPRJ`, computed by modeling. The record has room for it.

## Open questions and risks

- Can a `@group(3)` binding coexist with the instanced-edges module, or must the maps go in group 0?
- Should anisotropy and the 32-layer cap depend on the adapter's limits?
- Is moxcms ICC conversion acceptable in the Container, or should images with unknown profiles be rejected?
- Should a recipe bump re-make the patterns that old houses use? (This design says no: old keys stay valid.)
- Is it acceptable that wall reveals keep FCOL because they belong to no wall side?

## Next implementation step

Write `crates/display` `surface.rs` and `pattern.rs`, including the `MATL`/`FPRJ` codec and golden tests, because both the Container and the viewer build against those types.
