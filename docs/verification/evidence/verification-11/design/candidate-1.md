# Candidate 1: pattern display for issue #173, drawn inside viewport-gpu (route B)

This candidate draws the patterns inside SolidCraft's viewport-gpu as a base-colour map looked up per palette entry. Pattern coordinates come from a planar frame (origin, u, v in mm) that modeling works out at export from the housing planes. The frame is anchored to the plane itself, so wall endpoints do not affect it. The Container makes one 1024² sRGB JPEG per original image, the browser decodes it, and the wasm takes plain RGBA bytes and builds the mips on the CPU.

## Problem

Wood grain and tiles have to show at their real repeat size and orientation. They must survive a wall move, stretch or split, keep matching the lighting of plain faces, and leave room for future glass and sun shadows (6.5). Five facts make the shape non-obvious:

- **Glass breaks a viewer-owned pass.** `Renderer::paint` draws the whole frame offscreen as soon as one body is see-through (any opacity below 0.999, which turns OIT on) or `ssaa ≠ 1`. The viewer's depth buffer is then empty, so a pass the viewer draws after `paint` (route A) paints patterned faces over nearer walls.
- **Lighting works on sRGB-coded values.** `lit_color` is computed directly on the colour bytes, so a sampled texel has to reach it sRGB-coded or textured and plain faces won't match.
- **The palette is the only per-entry channel.** It already reaches every opaque source, and `Palette::with_materials` is an upstream example of a per-entry table stored in texture rows and keyed by palette index. `TRI_SIZE` has no free word.
- **Face numbers are not identities.** TFAC numbers belong to one artifact, so frames have to come from housing data (wall sides, storey bases, object placements).
- **Fixed limits elsewhere:**
  - The Worker does not decode images (5.2).
  - Only the Worker writes R2 (4.3).
  - API responses are `no-store` (4.7).
  - The viewer may depend only on geom, viewport and viewport-gpu among SolidCraft crates.

## Usage (caller's view)

**Web (`apps/web/src/viewer/viewport-session.ts`):**
```ts
const summary = viewer.show(displayBytes);           // draws now; patterned faces use their FCOL colour
for (const key of viewer.missing_patterns()) {        // 64-hex PatternKeys this scene needs that the GPU cache lacks
  patterns.rgba(key).then((rgba) => {                 // fetch is deduplicated, encoded bytes are LRU-cached
    if (viewer.put_pattern(key, rgba)) requestDraw(); // false: no longer wanted (plan switched), ignored
  });
}
```

**`apps/web/src/viewer/pattern-cache.ts`:**
```ts
export const patterns = createPatternCache({ maxEncoded: 64 });
// rgba(key): GET /api/patterns/:key -> image/jpeg -> createImageBitmap(blob,
//   {colorSpaceConversion:"none", premultiplyAlpha:"none"}) -> OffscreenCanvas 1024² -> getImageData
// Throws unless the image is exactly 1024x1024. One in-flight Promise per key.
```

**Modeling export (`crates/modeling/src/display.rs`, #176):**
```rust
let mut surfaces = SurfacesBuilder::default();
for (body, face, target) in model.patterned_faces() {      // face -> (wall side | floor | ceiling | object)
    let m = house.material(target.material)?;              // housing row: pattern key, repeat, angle
    surfaces.assign(body, face, m.pattern, surface::rule(&target, m)?)?; // Projection + RepeatFrame, f64 -> f32
}
let display = DisplayModel::new(bodies)?.with_surfaces(surfaces)?; // validated, canonical
```

**Worker (`apps/worker/src/services/patterns.ts`, #179):**
```ts
const { key, meanRgb } = await ensurePattern(env, owner, assetId); // idempotent, create-only
// key goes into the housing material row; GET /api/patterns/:key serves it with an owner check
```

## Shape

### 1. Route: B, a patch to viewport-gpu that I would offer upstream

**Public surface of the patch.** One new file, `viewport-gpu/src/surface.rs`, with:
```rust
/// Planar repeat frame: uv = (dot(p-o, u)/|u|², dot(p-o, v)/|v|²); |u|, |v| are one repeat in mm.
pub struct SurfaceMap { pub layer: u32, pub origin: [f32; 3], pub u: [f32; 3], pub v: [f32; 3], pub projection: Projection }
pub enum Projection { Planar, Box }        // Box: axes u, v, and n = normalize(cross(v, u)) scaled to |u|; triplanar blend
pub struct SurfaceImage { edge: u32, levels: Vec<Vec<u8>> } // Rgba8UnormSrgb, floor-halved chain down to 1x1
impl SurfaceImage { pub fn new(edge: u32, levels: Vec<Vec<u8>>) -> Result<Self, SurfaceError> { todo!() } } // power-of-two edge, exact level sizes
#[derive(Debug)] pub enum SurfaceError { Edge, LevelSize { level: u32 }, EdgeMismatch, LayerLimit, NonFinite }

impl Palette { pub fn with_surface_maps(self, maps: Vec<Option<SurfaceMap>>) -> Palette { todo!() } } // keyed by palette index, like with_materials
impl Renderer {
    /// Put (Some) or drop (None) the image in array layer `layer`. The array grows on demand
    /// (copied, capacity doubles, up to the device limit). Changing a layer never forces a scene re-upload.
    pub fn set_surface_image(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, layer: u32, image: Option<&SurfaceImage>) -> Result<(), SurfaceError> { todo!() }
}
```

**Inside the patch (private):**
- **Map rows:** three `Rgba32Float` texels per palette entry (origin plus a mode flag, u/|u|², v/|v|²). Written alongside the material rows, with the same diffing in `PaletteGpu::update`.
- **Bindings:** a `texture_2d_array<f32>`, a residency texture (`R8Uint`, one texel per layer) and a sampler, all on group 0. The sampler repeats, uses linear min/mag/mip filtering and `anisotropy_clamp = 8`.
- **Shader:** at the top of `solid()`, in uniform flow, compute `dpdx(wp)` and `dpdy(wp)`. In the map branch, use `textureSampleGrad` with those gradients projected into uv. That call is legal in non-uniform flow, so the "derivatives before `clipped()`" test still holds and Box faces can branch.
- **Colour:** `base = srgb_encode(texel.rgb)` replaces the palette colour before `lit(...)`. Lighting therefore sees sRGB-coded values, the same as plain faces.
- **No maps means no change:** the defaults are no maps, a 1×1 dummy array and no residency. The look users already have and headless captures stay the same, and glass, trans and OIT paths ignore maps.

**Why B.** It is the only route that stays correct with glass, `ssaa ≠ 1`, AO, and a later shadow term without the viewer re-implementing shading. Keying by palette index avoids widening `TRI_SIZE`, so ui-egui and tess.wgsl are untouched. `SceneMesh` (solidcraft-viewport) is not changed either: the viewer builds its `GpuScene` directly with `GpuScene::with_palette` and `tri`/`open_tri`/`glass_tri`, one palette entry per distinct (RGBA, surface) pair. The viewer drops `scene_geometry`, so it keeps one way to build a scene.

**Upstream.** Yes, offer it as a contribution: "planar base-colour maps in the raster viewport". It mirrors the path tracer's `PlanarFrame` conventions and the `with_materials` pattern. Until it is accepted, record `src/surface.rs`, `src/view.rs`, `src/lib.rs` and `shaders/viewport.wgsl` in `solidcraft.json` `localPatches` and in the 独自変更 section of `solidcraft.md`.

### 2. Coordinate rule (modeling computes it at export, in f64)

The material row carries the repeat `(w, h)` in mm and an angle θ. `R(θ)` rotates the in-plane axes: `u' = cosθ·û + sinθ·v̂` and `v' = −sinθ·û + cosθ·v̂`. Then `u = w·u'` and `v = h·v'`.

| Face | û, v̂ | Origin |
|---|---|---|
| Wall side (either side; n is the housing side normal, not the mesh normal) | û = Z×n (to the right as seen from the front), v̂ = Z | foot of the perpendicular from the world origin onto the side plane, at z = storey base |
| Floor top (+Z) | û = X, v̂ = Y (plan axes) | (0, 0, z_face) |
| Ceiling (−Z) | û = X, v̂ = −Y (not mirrored when seen from below) | (0, 0, z_face) |
| Object, planar face | the same rules in the object's own frame (placement origin, rotation φ) | placement point |
| Object, non-planar face (cylinder legs) | `Projection::Box` with u = w·X_obj, v = h·Z_obj (grain stays along the object's Z) | placement point |
| Opening reveal or arch intrados | `Box` in the wall's (û, Z) frame, only once housing has a reveal target role; until then FCOL colour | as for the wall |

**Why this holds under edits:**
- The wall frame depends only on (plane n, d, storey base, material).
- **Move:** d changes, but the along and rise coordinates do not.
- **Stretch:** the plane is unchanged, so the frame is bit-identical.
- **Split:** collinear pieces share the plane, so their frames are bit-identical and the tiles continue across the pieces.
- **No sign flips:** n comes from the face side, not from the start→end direction, so a split or merge cannot flip u.
- **Tile size:** |u| = w is fixed in every case.
- Floors are world-anchored, so the pattern continues through doorways between rooms that share a material. Furniture patterns move with the furniture.

**Planar or Box.** Modeling decides. A face is Planar if all its triangle normals lie within 0.5° of each other, otherwise Box. The choice is stored per surface in the display data.

**Where each invariant is checked:**

| Layer | What it checks |
|---|---|
| housing (parse) | repeat finite and within 1–100,000 mm, angle finite, key well formed |
| modeling | property tests on the pure rules: move, stretch and split invariance (frames equal; along coordinates of the same physical points unchanged) |
| display (decode and `with_surfaces`) | structure, listed in section 3 |
| viewport-gpu | finite values, layer within limits; never panics |
| viewer (#181 test) | uv worked out from a position matches the repeat size and orientation |

### 3. Representation: a planar frame per surface, worked out in the shader from `wp`; no per-vertex UVs

Three optional sections, all with flag 0, added to `KNOWN_OPTIONAL_KINDS` in this order. They appear all together or not at all.

| Kind | Record | Layout |
|---|---|---|
| `PTRN` | pattern table | u32 count, then `[u8; 32]` PatternKey each; sorted, unique, ≤ 4096 |
| `SURF` | surface (deduplicated) | u32 count, then 48 B each: `pattern u32, projection u32 (0 planar, 1 box), origin f32×3, u f32×3, v f32×3, reserved u32 = 0` |
| `FSRF` | face → surface | u32 count, then 12 B each: `body u32, face u32, surface u32`; strictly increasing by (body, face) |

**Validation:**
- references in range;
- the face actually appears in that body's TFAC;
- every f32 finite;
- |u| and |v| within 1–100,000 mm;
- u ⟂ v within 1e-4·|u||v|;
- |origin| ≤ 1e7;
- reserved bytes zero, `SURF` records unique, canonical order (the existing re-encode check covers the order).

**Fallback.** Modeling writes FCOL = the material colour for patterned faces. An old viewer, or a pattern that hasn't arrived yet, shows that colour. The only colour stored is FCOL; there is no second copy.

**Size for a large house:** about 10k patterned faces × 12 B ≈ 120 KB, plus a few hundred surfaces × 48 B, plus at most 50 keys × 32 B. That is well under 1% of 16 MiB. Per-vertex UVs would be about 8 B × 200k vertices ≈ 1.6 MB.

**Display types (sketch):**
```rust
pub struct PatternKey([u8; 32]);                      // parse_hex / to_hex
pub struct RepeatFrame { origin: [f32; 3], u: [f32; 3], v: [f32; 3] } // new() -> Result, validated
pub enum Projection { Planar, Box }
pub struct Surface { pattern: u32, projection: Projection, frame: RepeatFrame }
pub struct Surfaces { patterns: Vec<PatternKey>, surfaces: Vec<Surface>, faces: Vec<(u32, u32, u32)> } // private fields
impl Surfaces {
    pub fn patterns(&self) -> &[PatternKey] { todo!() }
    pub fn surfaces(&self) -> &[Surface] { todo!() }
    pub fn of_face(&self, body: u32, face: u32) -> Option<u32> { todo!() } // binary search
}
#[derive(Default)] pub struct SurfacesBuilder { /* dedup maps */ }
impl SurfacesBuilder {
    pub fn assign(&mut self, body: u32, face: u32, pattern: PatternKey, projection: Projection, frame: RepeatFrame) -> Result<(), ModelError> { todo!() }
}
impl DisplayModel {
    pub fn with_surfaces(self, s: SurfacesBuilder) -> Result<Self, ModelError> { todo!() }
    pub fn surfaces(&self) -> &Surfaces { todo!() } // empty when the sections are absent
}
```

### 4. Faces parallel to the projection

Box (triplanar) projection, recorded per surface in `SURF.projection` and chosen by modeling. Each fragment blends the three axis projections with weights `|n·axis|^4`. Projections with zero weight are skipped, which is legal because sampling uses `textureSampleGrad`. Planar faces sample once.

### 5. Mipmaps

- **Where:** CPU, in the viewer wasm, once per pattern image.
- **Recipe:** the edge is a fixed 1024² power of two, so each level is an exact 2×2 box average in linear light (sRGB decode table → average → encode). That gives 11 levels.
- **Upload:** `Rgba8UnormSrgb`, so hardware filtering is also sRGB-correct. The sampler uses trilinear filtering with 8× anisotropy.
- **Why not elsewhere:** nothing extra is stored or downloaded, and there is no GPU mip pass to put into the upstream patch.

### 6. Image flow

1. **Container** (new `POST /v1/patterns` in `crates/geometry-api`; body `image/png` or `image/jpeg`, ≤ 7,499,997 B; reply `image/jpeg`, ≤ 2 MiB, plus an `x-pattern-mean: rrggbb` header). It:
   - checks the signature;
   - decodes with the `image` crate under `Limits` (≤ 2576 px per side, ≤ 27 MB allocation);
   - applies EXIF orientation;
   - converts an embedded ICC profile to sRGB with moxcms (no profile is treated as sRGB);
   - composites alpha onto white;
   - resizes the whole image, without cropping, to 1024×1024 in linear light (the stored repeat size restores the aspect);
   - encodes sRGB JPEG at quality 90 with 4:4:4 sampling and no metadata, deterministically.

   Recipe id: `pattern/v1`.
2. **Worker**:
   - Key: `PatternKey = SHA-256("madori-pattern\0v1\0" ‖ original_sha256 ‖ crop?)`.
   - Lookup: check the D1 table `patterns(owner_id, key, asset_id, sha256, bytes, mean_rgb, recipe, created_at, PK(owner_id, key))`. If there is no row, read the original from R2, call the Container, `putNew owners/<owner>/patterns/<keyhex>`, then `INSERT … ON CONFLICT DO NOTHING`.
   - Crash recovery: if a run crashed after the R2 write, the next `putNew` conflict counts as present, and the run inserts the row.
   - Linking: the row links to the asset, which is what the asset list in #161 needs.
3. **Read route:** `GET /api/patterns/:key` (64 hex characters). Owner check on the D1 row, then the bytes as `image/jpeg` with `nosniff`. `no-store` stays as 4.7 requires. A missing row or another owner's pattern returns 404.
4. **Caches:**

   | Unit | Holds | Limit and eviction |
   |---|---|---|
   | R2 | one object per (owner, key), forever | none |
   | Web memory | encoded bytes per key, plus one in-flight Promise per key | LRU of 64 entries, kept across plan switches |
   | Wasm `PatternCache` | key → array layer | LRU over layers the current scene doesn't use; 16 layers to start |

   Nothing is cached in HTTP because of `no-store`.
5. **Wasm API:** RGBA8 bytes, exactly 1024×1024×4. This needs no decoder in the wasm and no extra web-sys features, and avoids the `.unwrap()` in `copy_external_image_to_texture` that panics the wasm when the browser throws.

**Viewer sketch:**
```rust
// crates/viewer/src/patterns.rs
pub const PATTERN_EDGE: u32 = 1024;
pub struct PatternCache { slots: Vec<Slot>, capacity: u32 } // Slot { key, resident, last_used }
impl PatternCache {
    /// Assign layers for this scene's keys (evicting unused, least-recently-used ones);
    /// keys that don't fit get None, and their faces show the FCOL colour.
    pub fn plan(&mut self, keys: &[PatternKey]) -> (Vec<Option<u32>>, Vec<u32> /* evicted layers */) { todo!() }
    pub fn missing(&self) -> Vec<PatternKey> { todo!() }
    pub fn accept(&mut self, key: &PatternKey) -> Option<u32> { todo!() } // layer if still wanted
}
pub fn mip_chain(rgba: &[u8]) -> Result<SurfaceImage, PatternError> { todo!() } // linear-light 2x2, 11 levels

// crates/viewer/src/scene.rs: replaces scene() + scene_geometry
pub fn build(model: &DisplayModel, layers: &[Option<u32>], key: u64) -> ShownScene { todo!() }
// palette: with_stable(one entry per distinct (rgba, surface)).with_surface_maps(...); push tris directly

// crates/viewer/src/gpu.rs (#[wasm_bindgen])
pub fn missing_patterns(&self) -> Vec<String> { todo!() }
pub fn put_pattern(&mut self, key: &str, rgba: &[u8]) -> Result<bool, Failure> { todo!() }
```

### 7. Sun shadows

The B route can host them:
- A light-space depth pass, modelled on the AO prepass (`OpaquePipelines`, depth in `R32Uint`, WebGL2-safe).
- A caster set passed in separately, so roofs hidden from display still cast shadows.
- The map bound in group 2 next to the AO maps.
- The shadow term multiplied in at `lit(i, occlusion(i))`.

Patterned faces get the shadow with no extra work, because the map only changes the base colour before `lit`.

### Interface depth

The upstream surface is two types, one builder method and one renderer method. Behind it sit residency, array growth, bind-group rebuilds, gradient-projected sampling, triplanar blending and sRGB handling. The viewer's public surface grows by two wasm methods. Modeling sees `SurfacesBuilder::assign` and does not deal with indices.

## Tradeoffs accepted

- We carry a local patch on `view.rs`, which changes often, in exchange for correct glass and OIT, matched lighting, and a shadow route that comes for free.
- Every pattern is stretched to a 1024² square, which loses some resolution on elongated images, in exchange for one texture array, exact mips and a simple cache.
- Patterns are refetched after a page reload, because 4.7 requires `no-store`. Within a session, plan switches don't refetch.
- Pattern coordinates in the shader are f32 relative to a nearby origin. They degrade only near the 10⁷ mm coordinate limit, where POSN itself is already f32.
- The viewer builds its `GpuScene` itself rather than calling `scene_geometry`: about 40 lines that partly overlap upstream logic, in exchange for leaving `SceneMesh` and solidcraft-viewport unpatched.

## Alternatives considered

- **A, a viewer-owned pass drawn after `paint`.** No upstream patch, but the first see-through body or `ssaa ≠ 1` makes patterned faces paint through walls. Glass is composited before the pass, so it never tints patterns. Shadows and AO would have to be re-implemented, so the viewer would drift toward drawing all opaque geometry itself. The public surface is shallow while the complexity leaks into the viewer.
- **Per-vertex UVs in MDSP, plus a wider `TRI_SIZE`.** About 1.6 MB of display data for a large house, and the vertex-format change ripples through about 10 `GpuScene` functions, ui-egui and tess.wgsl. Its precision advantage is irrelevant at house scale.
- **Images in a `Frame` or in the `GpuScene`.** Every plan switch would re-upload the images, or they would have to be hashed into `frame_key`. Layer residency that the renderer owns keeps scenes and images independent.
- **Decoding in the wasm (`image` with JPEG).** Adds zune-jpeg and image code to the wasm, and runs on the main thread. Decoding with `createImageBitmap` and handing over an ImageBitmap through `copy_external_image_to_texture` risks a panic when the browser throws.

## Open questions and risks

- Does group 0 have room for three more bindings in every pipeline that shares `bgl`, and does FXC accept `SampleGrad` on a `Texture2DArray`? If not, should the patch fall back to `textureSampleLevel` with a LOD it works out itself?
- Is it acceptable that the snapshot manifest does not list pattern keys? This design authorises reads by the owner's pattern row, not by revision. Plan 4.3 expects a new manifest version for material references.
- Should opening reveals get a housing target role now, or stay in FCOL colour until 6.3?
- Should an explicit Cache Storage layer survive reloads, given that 4.7's `no-store` is about privacy?
- Wall-plane origins assume the house sits near the plan origin. Should the Container re-centre a house far from it?

## Prototype observations that would change this design

| If the prototype shows | I would |
|---|---|
| A's `glass` toggle keeps correct occlusion (the offscreen-path reading is wrong) | still keep B for shadows, but re-weigh it against the cost of upstream merge conflicts |
| B's frame time at 8×8 rooms is more than about 2 ms (or 15%) above plain colour at 1080p | lower anisotropy from 8 to 4, then the layer edge to 512, before considering any route change (A draws every patterned face twice, so it can't be cheaper) |
| B's release wasm grows by more than about 40 KB brotli | check that no image or codec code got linked; the route stays |
| 16 layers × 1024² (≈ 90 MB) fails to allocate or thrashes on the target devices | use a 512² edge and/or 8 layers (the edge is one constant plus the recipe version) |
| CPU mips take more than 30 ms per layer in release wasm | add a GPU downsample pass inside the patch, or store the levels from the Container |
| Planar frames show shimmer or seams at normal house coordinates | send origins relative to the camera target, as the path tracer does |
| Triplanar on cylinder legs looks worse than one best axis per face | drop `Box` blending and pick a single axis per fragment |
| `start` vs world-anchored frames: the world-anchored ones still slide on a stretched wall | the plane-anchored rule is wrong; re-derive it |

## Rejected shapes, in short

- A, the viewer-owned pass: unsound with glass or `ssaa`, and a dead end for shadows.
- Widening the vertex format: too much ripple through upstream.
- Per-vertex UVs: 13× the display data for no gain at house scale.
- Decoding images in the wasm: size and main-thread cost.
- Passing ImageBitmap to the GPU directly: panic risk.
- Storing images per scene: re-uploads on every plan switch.
- Frames anchored at a wall's start vertex (today's `SideFrame`): the pattern slides on a stretched wall, and u can flip sign after a split.

## Next implementation step

Write `viewport-gpu/src/surface.rs` and the `solid()` change behind `Palette::with_surface_maps` and `Renderer::set_surface_image`. Test that output is identical with no maps, and that one map gives the expected repeat on a box room.
