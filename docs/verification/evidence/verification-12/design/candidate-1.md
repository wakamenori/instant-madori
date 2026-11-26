# Candidate 1: exact lit polygons, computed in the viewer from the display model

## Problem

Issue #203 must fix how direct sunlight is computed and what shape the result takes, so that
#204–#211 can be implemented against plan 4.8. The users are a salesperson and a homeowner moving a
month and a 30-minute slider during a meeting. Four constraints make the shape non-obvious:

- Correctness is pre-registered (task.md): floor, wall, sloped-ceiling areas within 1 %, horizontal
  ceilings exactly 0, slits of 50 mm down to 5 mm must stay lit within 20 %. Verification 2 showed a
  200 mm grid loses summer slivers, so any sampling method has a minimum feature size by construction.
- The viewer Wasm may not contain CAD kernel code (`scripts/check/boundaries.ts`,
  `viewer-wasm-contents`), so `kernel::planar_regions_boolean` and `face_hit_by_ray` cannot run there.
- Verification 11 proved that anything drawn after viewport-gpu's opaque pass breaks once a
  see-through body (glass) exists. Sunlight must be drawn inside the opaque pass, not as a floating
  overlay.
- The current split (#205/#210 compute in the Container, #204 binary result, #206–#208 routes and an
  R2 cache, #211 stale-response logic) prices every slider step at a Worker→Container round trip,
  possibly including a Container cold start.

The display model already holds every occluder as an f32 mesh, including the roof that the user may
hide (hiding is a viewer flag, not a data change). It lacks two things the computation needs: the site
(latitude, longitude, UTC offset, north angle) and which faces receive light and which bodies transmit
it. Plan 3.5 records face roles in the correspondence table, which modeling has at export time.

## Usage (caller's view)

README for `crates/sunlight`:

> `SunScene::prepare(&display_model)` once per model, then `scene.light(position)` per condition.
> `solar::position(scene.site(), SunQuery::new(year, month, slot)?)` gives the position. The result
> partitions every receiving face (floor, wall, ceiling) into exact lit and dark triangles. Same input
> bytes give the same output bits on x86_64 and wasm32. Nothing is sampled, so no slit is too thin.

Web (`apps/web`, #211 shrinks to this):

```ts
const s = viewer.show_sunlight(year, month, slot);     // synchronous, a few tens of ms at most
label.text = `${s.year}年${s.month}月${s.day}日 ${s.hour}:${pad(s.minute)}`;
if (s.state === SunState.BelowHorizon) badge.show("日が出ていない");
// toggling the roof or upper floor does not call anything; turning sunlight off:
viewer.clear_sunlight();
```

Modeling test (#205/#210 evidence, built through housing operations, then the real export):

```rust
let display = display::export(&session, &elements)?;            // now carries SITE and SUNR
let scene = SunScene::prepare(&display)?;
let sun = SunPosition::Above(SunDirection::from_angles(180.0, 30.0).ok_or("sun")?);
let light = scene.light(sun)?;
assert!((light.lit_area(Surface::Floor) - 2_046_307.0).abs() <= 20_463.0);
assert_eq!(light.lit_area(Surface::Ceiling), 0.0);
```

Viewer internals (#209):

```rust
let light = cache.get_or(query, || scene.light(solar::position(scene.site(), query)))?;
let (scene, bounds) = sun::scene_with_sunlight(&model, &light);   // lit pieces replace face triangles
```

## Shape

**Compute location: in the browser, in Rust, in the viewer Wasm** (fork option b, CPU variant). The
computation is a pure function of (display model bytes, sun position), lives in a new crate
`crates/sunlight` (deps: `madori-display`, `libm`, `i_overlay`; no SolidCraft, no CAD kernel), and
the viewer calls it. CI runs the same crate natively on the analytic fixtures. The Container is
untouched after it writes two optional sections into the display model it already produces.

- End-user experience: a slider step costs one in-process computation plus a scene rebuild, with no
  network, no Container, and no cold start. Revisits hit an in-memory LRU of 96 results per model.
- Stale results cannot happen: the result is computed from the model currently shown, synchronously.
  The identification problem of #204/#208/#211 (revision ID, conditions, method version, R2 keys,
  out-of-order responses) disappears instead of being solved. The cache key is `SunQuery`; the cache is
  owned by `ShownScene` and dies with it (per single source of truth, derive instead of sync).
- Determinism: inputs are f32 bits from the display model; the math is f64 `+ - * / sqrt` (correctly
  rounded on both targets, Rust does not contract to FMA); trig in `solar` uses `libm` so wasm32 and
  x86_64 agree bit for bit; projected vertices are snapped to a 1/64 mm integer grid before an
  integer-exact boolean (`i_overlay`, MIT). A CI test hashes the fixture output natively and on
  wasm32 (node) and requires equality.

**Method: exact projection (task method E) on the display mesh.** Per receiving face F with outward
normal n and sun s: if n·s ≤ 0 the face is dark with zero work, which makes every horizontal ceiling
exactly 0 and walls facing away free. Otherwise lit(F) = F − ∪ proj_s(occluder parts in front of F).
Data structure, traced against the dominant access (many faces × one sun):

- `SunScene` (sun-independent, built once): receivers grouped by plane class (same normal within 1e-9);
  per face its plane offset d, a 2D frame, and its outline = union of its display triangles. Occluders:
  all triangles of `Blocks` bodies in f64.
- Per call, per plane class: project every occluder once along s onto the class reference plane,
  record its height range along n, bucket it in a uniform 2D grid. Faces on parallel planes see the
  same projection shifted by `(d / n·s) s`, so one projection and one grid serve all floors of all
  storeys. Per face: grid query with its shifted box, drop triangles wholly behind F, clip straddlers
  in 3D, one Difference(outline, NonZero union) call, triangulate lit and dark.

Display mesh, not B-rep, is the truth: it is what is drawn, so lit edges sit exactly on drawn edges,
and planar faces tessellate exactly. Glass is excluded by `BodyLight::Transmits`, set by modeling from
the element kind (answers #205's open question: by element kind, never by name or opacity).

**Result shape: a per-face partition into lit and dark triangles** (`FaceLight { lit: Region, dark:
Region }`, fields private, built only by `light`). It never travels: there is no result byte format.
What travels is input, in the display model as two optional sections (flag 0, old viewers ignore them,
re-encode stays canonical per 4.8):

- `SITE`: latitude, longitude, UTC offset (minutes), north angle. Written from the housing site
  (#189), so site and geometry come from one snapshot and cannot disagree.
- `SUNR`: one `BodyLight` per body; ascending `(Receiver{body, face}, Surface)` list. Validated on
  decode: existing body, existing TFAC face, no receiver on a transmitting body.

A display model without these sections (stored before this change) shows "日差しは再生成が必要" via
`SunState::Unavailable`; R2 objects are never rewritten.

**Drawing: replace, do not overlay.** `scene_with_sunlight` substitutes each receiving face's triangles
with its lit and dark pieces before `scene_geometry`. Dark pieces keep the face's palette entry; lit
pieces get a palette entry with the same colour and texture projection plus one new "sunlit" flag that
the opaque fragment shader turns into a warm multiplier. This is one bit next to the verification-11
texture change, recorded as the same kind of local upstream change. Consequences: no z-fighting (#209's
concern) because nothing is coplanar-duplicated; lighting, AO, glass composite and textures apply to lit
pieces like any face; hiding the roof hides roof bodies only, the lit pieces stay (2.3).

**Below the horizon:** `solar::position` returns `SunPosition::Below`; `light` returns
`Sunlight::Below` without touching geometry; the viewer draws the plain scene and returns
`BelowHorizon`.

**Limits (counts, never wall clock, so results stay deterministic):** receiving faces ≤ 4,096;
occluder triangles ≤ 1,000,000 (the 16 MiB display cap already bounds this); shadow triangles per face
≤ 50,000; output vertices per call ≤ 2,000,000. Exceeding one returns `TooComplex { receiver }`, shown
as a failure, never silently coarsened (#205).

Interface depth: the public surface is `prepare`, `light`, `solar::position`, and read-only result
accessors. Hidden behind it: plane classes, projection reuse, grids, 3D clipping, snapping, the
boolean library, triangulation, and limit policy. The viewer adds two Wasm methods. Per
boundary-discipline the display sections are parsed into domain types at decode; per
encode-lessons-in-structure `SunPosition::Below` makes "no ray work at night" unrepresentable to skip.

**Effect on the issue split:** #201 lands in `crates/sunlight::solar`. #204 becomes "SITE and SUNR
optional sections" in `crates/display` (no result format, no media type). #205/#210 become "modeling
writes SITE/SUNR" plus "crates/sunlight computes floors / walls and ceilings"; their test lists stand
unchanged, run from modeling against the real export. #209 is the face replacement plus the sunlit
flag. #206, #207, #208 close as not needed; plan 4.7 drops `POST /api/revisions/:id/sunlight`.
#211 becomes the slider wiring above. Plan 4.2 gains the crate and the rows "sunlight → display",
"viewer → sunlight", "modeling (dev) → sunlight" in `boundaries.ts`.

## Measurable conditions that flip a choice

| Choice | Flip when (measured on the two-storey fixture unless noted) | Fall back to |
| --- | --- | --- |
| Method E | E misses any pre-registered tolerance, or the boolean errors on any fixture | Q (adaptive, 5 mm floor) with `MeshIndex::raycast`, cells merged into the same `Region` type |
| E on display mesh | display mesh and B-rep rays disagree by > 1 cm² on a planar face in the analytic fixtures | investigate tessellation; keep mesh unless an analytic test fails |
| Synchronous in viewer | per-condition `light` > 15 ms native arm64 (≈ 50 ms wasm on a mid laptop), or > 50 ms in wasm32 under node | run `crates/sunlight` in a dedicated Web Worker with its own Wasm |
| Browser at all | per-condition > 250 ms native, or prepare memory > 100 MB | compute the same crate in the Container (option a) behind #206, add an `MSUN` stream in `crates/display`, restore #207/#208 |
| Replace-and-rebuild | `scene_with_sunlight` + `scene_geometry` + upload > 16 ms for the house | rebuild only receiving bodies' batches (viewport-gpu partial update) |
| `i_overlay` | viewer Wasm grows > 150 KB gzipped | own Martinez–Rueda on the integer grid |
| 1/64 mm snap | any slit fixture loses > 1 % area to snapping, or i32 overflow on a fixture | 1/16 mm grid with pre-clip to the face box |

The prototype does not measure wasm32; add one run of E on wasm32 under node to decide the third row.

## Tradeoffs accepted

- We accept a new crate and a third-party 2D boolean in the Wasm in exchange for instant slider
  response and the removal of four issues' worth of API, cache and staleness machinery.
- We accept that old stored display models show no sunlight until regenerated, in exchange for keeping
  the site and roles in one snapshot instead of a second input channel from the Web.
- We accept computing on the user's device (variable speed) in exchange for no Container load per
  slider step; the limits are count-based so a slow device is slower, never different.
- We accept rebuilding scene geometry per condition, which looks wasteful, in exchange for drawing
  sunlight through the exact same opaque path as every other face.

## Alternatives considered

- **(a) Container, current split.** Same algorithm is possible there, and B-rep is reachable, but every
  uncached step pays network and possibly a Container cold start; it needs a result format, three
  routes, an R2 key scheme with method versions, and out-of-order rejection. More surface exposed to
  more callers for the same answer. Kept as the fallback in the table.
- **(b-GPU) Shadow map in viewport-gpu.** Instant and already sketched in plan 4.8's last paragraph,
  but a 4096² map over house plus neighbours is ≈ 7 mm per texel, so a 5 mm slit vanishes or shimmers;
  no area numbers for analytic tests; GPU-dependent output; CI has no GPU. That paragraph stays as a
  separate rendering-shadow feature, not as the sunlight answer.
- **Sampling (G/A/Q) as the primary method.** Every grid has a minimum feature; A additionally trusts
  that light only enters through openings it knows about. They remain the fallback only.
- **Floating overlay meshes for lit regions.** Rejected by verification 11: anything drawn after the
  opaque pass is wrong once glass exists, and coplanar overlays need depth bias.

## Open questions and risks

- Is a mid-range sales laptop or iPad the reference device for the 50 ms budget, and who measures it?
- Lit strips narrower than a pixel at the current zoom may rasterize to nothing even though the data
  keeps them. Should lit pieces narrower than ~2 px get a minimum drawn width or rely on MSAA?
- Do neighbour houses always appear in the display model as bodies? If a later design hides them from
  the data, they must still be `Blocks` bodies.
- Is closing #206–#208 acceptable to the coordinator, given they were planned around plan 4.7's route?

## Next implementation step

Add `SITE` and `SUNR` to `crates/display` with decode validation, and start `crates/sunlight` with
`prepare` plus the floor analytic fixture on a hand-built `DisplayModel`.

## Type sketch

```rust
// Candidate 1 type sketch: exact lit polygons, computed in the viewer Wasm from the display
// model, with the Container never involved after the display model is built.
//
// Module map
//
//   crates/display            (no deps, as today)
//     src/model.rs            + Site, SunRoles, BodyLight, Surface, Receiver; DisplayModel accessors
//     src/codec/v1.rs         + optional sections SITE and SUNR (flag 0, after FCOL and texture sections)
//   crates/sunlight           NEW. deps: madori-display, libm, i_overlay. No SolidCraft, no CAD kernel.
//     src/lib.rs              pub: SunScene, SunPosition, SunDirection, SunQuery, Sunlight, FaceLight,
//                             Region, PrepareError, SunlightError, solar::position. Everything else private.
//     src/solar.rs            NOAA position (#201) in libm, so native and wasm32 give identical bits
//     src/receivers.rs        per receiving face: plane frame, 2D outline (union of its display triangles)
//     src/occluders.rs        occluder triangles grouped by receiver plane class; per-sun 2D grid
//     src/shadow.rs           clip occluders in front of a receiver, project along s, snap, boolean
//     src/limits.rs           operation-count limits (no wall clock, so results stay deterministic)
//   crates/modeling           display.rs writes SITE (from housing site, #189) and SUNR (from face roles,
//                             3.5); dev-dependency on madori-sunlight for the analytic fixtures (#205, #210)
//   crates/viewer             deps + madori-sunlight. src/sun.rs: cache + face replacement; gpu.rs: entry
//   third_party/solidcraft    viewport-gpu: one palette flag "sunlit" in the opaque fragment shader
//                             (same place and same local-change record as the verification-11 textures)

// ───────────────────────────── crates/display/src/model.rs (additions) ─────────────────────────────

/// Where the house stands and how it is turned. Written by modeling from the housing site (#189);
/// the viewer never gets these values from anywhere else, so a display model and its sunlight
/// cannot disagree about the site.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Site {
    latitude_deg: f64,      // [-90, 90]
    longitude_deg: f64,     // [-180, 180]
    utc_offset_min: i16,    // [-720, 840], a multiple of 15
    north_from_y_deg: f64,  // [0, 360): true north measured clockwise from house +Y
}
impl Site {
    pub fn new(
        latitude_deg: f64,
        longitude_deg: f64,
        utc_offset_min: i16,
        north_from_y_deg: f64,
    ) -> Result<Self, ModelError> {
        todo!("reject non-finite and out-of-range values")
    }
    pub fn latitude_deg(&self) -> f64 { todo!() }
    pub fn longitude_deg(&self) -> f64 { todo!() }
    pub fn utc_offset_min(&self) -> i16 { todo!() }
    pub fn north_from_y_deg(&self) -> f64 { todo!() }
}

/// How a body takes part in direct sunlight. Decided by modeling from the housing element kind
/// (opening glass transmits), never from the display name or the opacity (3.5, #205).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BodyLight {
    Blocks,
    Transmits,
}

/// The room-air side a receiving face belongs to (3.5 face roles).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Surface {
    Floor,
    Wall,
    Ceiling,
}

/// One B-rep face of one body that shows sunlight.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Receiver {
    pub body: u32, // index into DisplayModel::bodies
    pub face: u32, // a TFAC face id of that body
}

/// Section SUNR. Invariants (checked by `new` and on decode): one BodyLight per body, receivers
/// strictly ascending, each receiver names an existing body and one of its TFAC faces, and no
/// receiver lies on a Transmits body.
#[derive(Clone, Debug, PartialEq)]
pub struct SunRoles {
    bodies: Vec<BodyLight>,
    receivers: Vec<(Receiver, Surface)>,
}
impl SunRoles {
    pub fn new(
        bodies: Vec<BodyLight>,
        receivers: Vec<(Receiver, Surface)>,
    ) -> Result<Self, ModelError> {
        todo!("order and count checks; cross-checks against bodies happen in DisplayModel::with_sunlight_inputs")
    }
    pub fn body(&self, index: usize) -> BodyLight { todo!() }
    pub fn receivers(&self) -> &[(Receiver, Surface)] { todo!() }
}

impl DisplayModel {
    /// Attach the two optional sections. Modeling always writes both; a model without them (older
    /// stored artifacts) simply has no sunlight, and the viewer says so.
    pub fn with_sunlight_inputs(self, site: Site, roles: SunRoles) -> Result<Self, ModelError> {
        todo!("cross-check roles against self.bodies and their faces")
    }
    pub fn site(&self) -> Option<&Site> { todo!() }
    pub fn sun_roles(&self) -> Option<&SunRoles> { todo!() }
}

// ───────────────────────────── crates/sunlight/src/lib.rs ─────────────────────────────

use madori_display::{DisplayModel, Receiver, Site, Surface};

/// 1..=12, 21st of the month (2.3). Constructed only through `new`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SunQuery { year: u16, month: u8, slot: u8 /* 0..48, half hours of local standard time */ }
impl SunQuery {
    pub fn new(year: u16, month: u8, slot: u8) -> Result<Self, QueryError> { todo!("year 2000..=2100") }
    /// (year, month, 21, hour, minute), for the "actually computed date and time" label (2.3).
    pub fn civil(&self) -> (u16, u8, u8, u8, u8) { todo!() }
}
#[derive(Debug)]
pub enum QueryError { Year, Month, Slot }

/// Unit vector from a point toward the sun, house coordinates (+X east, +Y north, +Z up), z > 0.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SunDirection([f64; 3]);
impl SunDirection {
    /// For analytic tests: azimuth clockwise from house +Y, elevation above the horizon.
    pub fn from_angles(azimuth_deg: f64, elevation_deg: f64) -> Option<Self> {
        todo!("None when elevation <= 0 or non-finite")
    }
    pub fn vector(&self) -> [f64; 3] { todo!() }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SunPosition {
    Above(SunDirection),
    /// Elevation <= 0. No ray work is done (#205).
    Below,
}

pub mod solar {
    use super::*;
    /// NOAA approximation (#201), libm only, no refraction. Azimuth uses the corrected form #201 records.
    pub fn position(site: &Site, query: SunQuery) -> SunPosition { todo!() }
}

/// Everything about the model that does not depend on the sun: receiver frames and 2D outlines,
/// occluder triangles in f64, grouped by receiver plane class. Built once per display model.
pub struct SunScene { /* private: receivers::Receivers, occluders::Occluders */ }

impl SunScene {
    /// Fails when the model has no SITE/SUNR, a receiving face is not planar within 0.01 mm, or the
    /// model exceeds the limits in `limits.rs`.
    pub fn prepare(model: &DisplayModel) -> Result<SunScene, PrepareError> { todo!() }

    pub fn site(&self) -> &Site { todo!() }

    /// Exact lit and dark regions of every receiving face. Pure and deterministic: the same model
    /// bytes and the same `sun` give bit-identical output on x86_64 and wasm32.
    ///
    /// // TODO per call:
    /// // 1. s = sun vector. For each receiver plane class with n·s <= 0 (all horizontal ceilings,
    /// //    walls facing away), every face is fully dark: no work.
    /// // 2. Project all Blocks triangles along s onto the class reference plane once; store the
    /// //    signed height range along n; bucket in a uniform 2D grid. Parallel planes differ only by
    /// //    a translation (d·s/(n·s)), so one projection serves every face of the class.
    /// // 3. Per face: query the grid with the face's translated 2D box; drop triangles entirely
    /// //    behind the face plane (+0.01 mm); clip straddling ones in 3D against the plane; skip
    /// //    triangles of the receiving face itself.
    /// // 4. Clip each projected triangle to the face box, snap to a 1/64 mm integer grid, and run one
    /// //    i_overlay Difference(face outline, NonZero union of shadows). Dark = outline − lit.
    /// // 5. Triangulate lit and dark in 2D, lift to 3D on the face plane, f32.
    pub fn light(&self, sun: SunPosition) -> Result<Sunlight, SunlightError> { todo!() }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Sunlight {
    Below,
    Above { sun: SunDirection, faces: Vec<FaceLight> },
}
impl Sunlight {
    /// Summed lit area in mm², for tests and the viewer summary.
    pub fn lit_area(&self, surface: Surface) -> f64 { todo!() }
}

/// A partition of one receiving face. Invariant: lit ∪ dark covers exactly the face's display
/// triangles (up to the snap grid) and they do not overlap. Only `SunScene::light` builds it.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceLight {
    receiver: Receiver,
    surface: Surface,
    lit: Region,
    dark: Region,
}
impl FaceLight {
    pub fn receiver(&self) -> Receiver { todo!() }
    pub fn surface(&self) -> Surface { todo!() }
    pub fn lit(&self) -> &Region { todo!() }
    pub fn dark(&self) -> &Region { todo!() }
}

/// Triangles on the face plane, f32 world positions, ready to replace the face's display triangles.
#[derive(Debug, Clone, PartialEq)]
pub struct Region { positions: Vec<[f32; 3]>, triangles: Vec<[u32; 3]>, area_mm2: f64 }
impl Region {
    pub fn positions(&self) -> &[[f32; 3]] { todo!() }
    pub fn triangles(&self) -> &[[u32; 3]] { todo!() }
    pub fn area_mm2(&self) -> f64 { todo!() }
}

#[derive(Debug)]
pub enum PrepareError { NoSunlightInputs, NonPlanarReceiver(Receiver), TooLarge(&'static str) }
#[derive(Debug)]
pub enum SunlightError { TooComplex { receiver: Receiver }, Boolean { receiver: Receiver } }

// ───────────────────────────── crates/viewer (additions) ─────────────────────────────

// src/sun.rs (private)
pub(crate) struct SunCache { // owned by ShownScene, dropped with it when the model changes
    scene: SunScene,                                       // prepared lazily on first show_sunlight
    cache: Vec<(SunQuery, std::sync::Arc<Sunlight>)>,      // LRU, at most 96 entries (two months)
    shown: Option<SunQuery>,
}
/// Build the drawable scene with every receiving face's triangles replaced by its lit and dark
/// pieces. Lit pieces get a palette entry with the "sunlit" flag and the face's own colour and
/// texture projection; dark pieces keep the face's ordinary entry. No overlay geometry, so no
/// z-fighting and nothing drawn after the see-through composite (verification 11).
pub(crate) fn scene_with_sunlight(
    model: &DisplayModel,
    light: &Sunlight,
) -> (solidcraft_viewport::Scene, solidcraft_geom::Aabb3) { todo!() }

// src/lib.rs
#[wasm_bindgen::prelude::wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub enum SunState { Lit, BelowHorizon, Unavailable }

#[wasm_bindgen::prelude::wasm_bindgen]
pub struct SunlightSummary {
    pub state: SunState,
    pub year: u16, pub month: u8, pub day: u8, pub hour: u8, pub minute: u8,
    pub floor_m2: f64, pub wall_m2: f64, pub ceiling_m2: f64,
}

// src/gpu.rs
#[wasm_bindgen::prelude::wasm_bindgen]
impl Viewer {
    /// Show direct sunlight on the shown model for the 21st of `month`, half-hour `slot`.
    /// Synchronous; served from the cache when the same query was shown for this model.
    /// Errors: DisplayInvalid-like code `SunlightUnavailable` for bad query or limits exceeded.
    pub fn show_sunlight(&mut self, year: u16, month: u8, slot: u8) -> Result<SunlightSummary, Failure> {
        todo!("SunQuery::new → solar::position(site) → cache or SunScene::light → scene_with_sunlight → mark dirty")
    }
    /// Back to the plain scene. The cache is kept until the shown model changes.
    pub fn clear_sunlight(&mut self) { todo!() }
}
```
