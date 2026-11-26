# Candidate 2: exact lit polygons, computed in the viewer Wasm from the display data

## Problem

Issue #203 must fix how direct sunlight is found inside a planned house, what shape the result has, and how it is drawn on floors, walls and ceilings, for a month and a 30-minute step picked in the UI during a sales meeting. Constraints from the grounding:

- Light comes through openings and is blocked by walls, furniture, roofs (including roofs hidden in the view), stairs, upper floors and neighbours. Glass lets light through (2.3, 4.8). Today modeling creates no glass or door-leaf bodies (3.5), so an opening is just a hole.
- Slits of light 50 mm wide or narrower must not vanish. The fixtures go down to a 5 mm strip (ψ = 12.680°). The analytic cases must come within 1 % of the exact value, and a horizontal ceiling must come out at exactly 0.
- `crates/display` owns a versioned byte format. Optional sections may be added without a version bump (4.8). The Worker and the Web pass the bytes through without reading them.
- `crates/viewer` uses only geom, viewport and viewport-gpu, and its Wasm must not contain the CAD kernel (`viewer-wasm-contents`). An overlay drawn by our own pipeline breaks once anything is see-through: the viewer's depth buffer stays empty (verification 11, case A).
- There is a precedent that matters here. Picking already runs **in the browser, on the display mesh** ("サーバーで視線と形状を交差させない", 4.8). The browser already holds every occluder, including the hidden roof, as f32 triangles.

The current plan computes sunlight in the Container. That costs four issues (#206 internal route, #207 public API, #208 R2 cache, plus the network half of #211) whose only job is to move a few KB computed from data the browser already has. It also puts a Worker → Container round trip, and possibly a cold start, between the salesperson's click and the picture.

## Usage (caller's view)

The quickstart for the web implementer (#211):

```ts
// apps/web: month / time control. No fetch, no stale-response handling.
const s = viewer.showSunlight(2026, 12, 18);        // year, month 1..12, half-hour slot 0..47 (18 = 09:00)
if (!s.available) note("この案の表示データは日差しに未対応");  // display bytes without SITE/RECV
else if (s.belowHorizon) badge("日が出ていない");
else caption(`${s.year}年${s.month}月21日 ${s.hhmm} JST・床 ${s.floorM2.toFixed(2)} m²`);
viewer.clearSunlight();                              // the "hide sunlight" control
// Toggling the roof or upper floor does not touch sunlight: it is not recomputed or redrawn.
```

Call site in the viewer (`crates/viewer/src/sunlight.rs`):

```rust
let scene = self.sun_scene.get_or_try_init(|| SunScene::prepare(&self.model))?; // once per shown model
let sun = SunPosition::at(scene.site(), SunCondition::new(year, Month::new(month)?, HalfHour::new(slot)?));
let lit = self.memo.get_or_insert(sun.key(), || scene.light(&sun))?;           // Sunlight
self.overlay = Overlay::build(self.key, &lit);       // goes into the pv_slot, keyed by the shown scene
```

Call site in modeling's production export (#205 and #210 add the two input sections):

```rust
let model = display::export(&session, &elements, &SunInputs { site: house.site(), receivers: receivers(&session, &map)? })?;
```

Call site in a modeling test, with the house built through house-data operations (#205, #210):

```rust
let scene = SunScene::prepare(&export_house(&house)?)?;
let lit = scene.light(&SunPosition::from_angles(Deg(30.), Azimuth::SOUTH))?;
assert_close(lit.area_m2(ReceiverKind::Floor), 2.046307, 0.020463);
```

## Shape

**Compute location: (b′), CPU in the viewer Wasm, from the decoded display data.** The computation lives in a new pure crate, `crates/sunlight` (`madori-sunlight`). Its only dependency is `madori-display`. The viewer calls it, and modeling uses it as a dev-dependency so the analytic tests can run on real houses. Because the function is pure over a `DisplayModel`, moving the work later to a Web Worker, or back to the Container, changes the shell and not the computation. That makes the location fork cheap to reverse once the timings arrive.

**Method: exact projection with convex subtraction (method E), on the display mesh.** For each receiver triangle R, with plane normal n_R facing into the room:

1. If n_R·s ≤ 0, R is dark, and nothing is tested. This is why a horizontal ceiling comes out at exactly 0, with no tolerance involved.
2. Candidate occluders come from a light-space grid. Each occluder triangle is projected onto the plane ⟂ s once per sun direction. Triangles of closed bodies are culled if they face away from the sun.
3. Each candidate T is clipped to the sun side of R's plane, projected along s onto that plane, and clipped to R's 2D bounds, which keeps coordinates finite near the horizon.
4. `lit` starts as {R} and stays a list of convex pieces. Each projected T is subtracted from it: a convex piece minus a triangle gives at most 3 convex pieces. The candidates are sorted by overlap area, largest first, so the ceiling or upper floor removes most of a floor in the first step, and the loop stops once `lit` is empty.
5. Pieces with an area below 1e-2 mm² or a width below 1e-3 mm are dropped. These are numerical slivers along shared edges. The 5 mm slit is three orders of magnitude above that floor.

This is exact up to f64 rounding, so a slit vanishes only if it really is closed. The display mesh is canonical, as it already is for picking. On planar faces it is the B-rep face triangulated without loss. On curved faces it differs by the chord error, which is below what a viewer can see.

**Determinism.** The geometry uses only + − × ÷ and sqrt, which IEEE 754 rounds correctly; `mul_add` and transcendental functions are banned in `clip.rs` and `index.rs`. The sun vector, which comes from sin and cos, is quantized to a 2⁻³⁰ grid before any geometry runs. With identical input bits, native code and wasm32 give bit-identical results, so a CI test can pin a result digest.

**Inputs travel inside the display data, as two new optional sections.** They are written by modeling, which owns the semantics. This is #204's new scope:

- `SITE`: latitude, longitude, UTC offset in minutes, and the north azimuth in the house frame. Taken from house data (#189).
- `RECV`: the receiver faces, as `(body index, face id, kind ∈ {Floor, Wall, Ceiling}, room ElementId)`. Modeling already knows the room-facing role of every face (3.5 face roles), so the browser never guesses what is interior.
- Every body occludes unless it is listed in a future `LTRN` (light-transmitting) section. That section is added together with the first glass body. Light transmission is never inferred from a colour's alpha.
- The roof is always in the display data. Hiding it is a viewer-scene choice, and `SunScene::prepare` takes the `DisplayModel`, not the visible `Scene`. The hidden-roof rule (2.3) therefore holds by type: the computation cannot see the visibility toggles.

**Result shape: per receiver face, a list of lit triangles in f32 world coordinates, plus the area in f64.** The result never leaves the Wasm memory, so it has no byte format. The viewer turns it into one overlay `Scene` placed in viewport-gpu's `pv_slot`. That slot is drawn in the same opaque, depth-tested pass as the model, so the glass/depth trap of verification 11 does not apply, and the model geometry is never re-uploaded. Details:

- Each patch is offset 1 mm along n_R (reverse-Z f32 at room scale resolves this) and drawn opaque in a warm yellow, with `closed: false`.
- `tri_face` is set to the receiver's ordinal, so outlines appear only at the edge of the lit region and not along the internal piece edges.
- One mechanism covers floors, walls and ceilings. A sloped ceiling gets light only when its normal faces the sun, which is the #210 rule, and this falls out of step 1.

**Below the horizon.** If `SunPosition` has an altitude ≤ 0 (no refraction, matching #201), `light` returns `Sunlight::BelowHorizon` without touching any geometry, and the viewer clears the overlay. `BelowHorizon` is a variant and not an empty patch list, so the UI cannot confuse "night" with "no light reaches the rooms".

**Size and time limits, with work counted deterministically.** `light` counts convex-clip operations against `Budget { clips: 4_000_000, pieces: 65_536 }`. When either limit is crossed it returns `LightError::TooComplex { receiver }`, which the UI shows as "この案は日差しを計算できない". It never coarsens the answer silently. The budget is counted in operations, not milliseconds, so a model passes or fails the same way on every device and in CI. The initial values are 10× the maximum measured on the two-storey fixture. `prepare` rejects more than 2,000,000 occluder triangles; the 16 MiB display limit already bounds this in practice.

**Identification and stale rejection.**

- The memo key is `(scene key, SunKey { year, month, slot, quantized s })`. The memo lives on the shown model, holds 96 entries, and is dropped by `show()`.
- The site comes from the same display bytes as the geometry, so a result can never mix one revision's site with another revision's walls.
- The overlay records the scene key it was built for, and `draw` skips an overlay whose key differs. With the synchronous call this check cannot fail. It starts to matter only if the Worker variant below is adopted, and then it is the whole stale-rejection mechanism.
- There is no server cache to invalidate. A change of method needs no version key, because the code that computes is the code that draws.

**Interface depth.** The web gets `showSunlight` and `clearSunlight` and never sees geometry or bytes. `madori-sunlight` exposes `SunScene::{prepare, light, site}`, `SunPosition::{at, from_angles}` and `Sunlight`. Light-space indexing, clipping, slivers, budgets and quantization are all private modules.

### Module map

| Path | Owns | New or changed |
| --- | --- | --- |
| `crates/sunlight/src/lib.rs` | public surface: `SunScene`, `Sunlight`, `LitPatch`, errors | new |
| `crates/sunlight/src/sun.rs` | NOAA sun position (#201 lands here), `SunCondition`, `Month`, `HalfHour`, quantization | new |
| `crates/sunlight/src/scene.rs` | `prepare`: f64 occluders, receivers, culling flags | new, private internals |
| `crates/sunlight/src/index.rs` | light-space grid per sun direction | new, private |
| `crates/sunlight/src/clip.rs` | convex piece minus triangle, sliver drop, budget counter | new, private |
| `crates/display/src/site.rs`, `receivers.rs` | `SITE` / `RECV` optional sections, decode validation | changed (#204) |
| `crates/modeling/src/display/receivers.rs` | which faces receive light, from face roles | new (#205 floors, #210 walls/ceilings) |
| `crates/viewer/src/sunlight.rs` | memo, overlay `Scene`, `pv_slot` wiring | new (#209) |
| `crates/viewer/src/gpu.rs` | `Viewer::show_sunlight` / `clear_sunlight` | changed (#209) |
| `scripts/check/boundaries.ts` | `madori-sunlight → madori-display` only; viewer may depend on it; modeling only as dev-dependency | changed |

### Effect on the issue split

| Issue | Change |
| --- | --- |
| #201 | Unchanged. It goes into `crates/sunlight/src/sun.rs`. |
| #204 | Defines the `SITE` + `RECV` sections instead of a result stream. |
| #205 | Builds `crates/sunlight` plus floor receivers; its test list carries over verbatim. |
| #210 | Only adds wall and ceiling receivers in modeling. |
| #209 | Draws the `pv_slot` overlay and the two Wasm calls. |
| #211 | Shrinks to the UI control and badges. |
| #206, #207, #208 | Closed as not needed. |
| Plan 4.7 | `POST /api/revisions/:id/sunlight` is removed. |

## Tradeoffs accepted

- **Weaker devices.** We accept that the speed of the salesperson's device now bounds the time to answer, in exchange for no network, no Container cold start, no cache and no stale-response protocol. The time-change response is one synchronous Wasm call.
- **Old revisions.** We accept that revisions whose stored display bytes predate `SITE`/`RECV` show sunlight as unavailable, in exchange for a single source of truth per revision. R2 objects are never rewritten (4.8).
- **Display mesh as the truth.** We accept the display mesh's chord error on curved faces, in exchange for the same truth that picking uses, and for no CAD kernel in the Wasm.
- **No texture under the patch.** We accept opaque patches that hide the floor texture beneath them, in exchange for staying out of the see-through (OIT) path and adding no upstream change. A translucent patch can come later.
- **Hard limit.** We accept a hard `TooComplex` failure instead of a coarser answer, as #205 requires.

## Alternatives considered

- **(a) Container computes (method E or sampling) and ships a versioned result stream: the current plan.** It hides nothing extra from the browser and exposes four more issues' worth of protocol (route, public API, R2 key design, stale rejection), all to move data derived from bytes the browser already holds. Each 30-minute step pays a round trip. This stays as the fallback, and the same `madori-sunlight` crate would run inside modeling.
- **(b) GPU shadow map in viewport-gpu.** It gives the best interactivity, but a 4096² map over a site about 40 m across has texels of about 10 mm, so the 5 mm strip falls under one texel and PCF blurs it away. The result is GPU-dependent, so analytic areas cannot be asserted in CI. It also needs an upstream pass with a separate caster set for the hidden roof. It remains right for the plan's realistic-shadow paragraph, which is a different feature.
- **Sampling with raycasts (G, A, Q).** G at 5 mm is about 40× the work of E. A assumes light enters only through openings, which misses stair holes and gaps under the eaves. Q can miss a slit entirely: a 5 mm strip inside a 200 mm cell whose four corners and centre are all dark never triggers a split. That breaks the "must not vanish" rule by construction, not merely by tuning.
- **Per-vertex lit values on the display mesh (`SceneMesh.values`).** The light boundary does not follow mesh edges, so this needs mesh refinement and gets edges no sharper than the cells.
- **B-rep rays via `face_hit_by_ray` (solidcore-ops).** It would need a boundary-table change, would work only in the Container, and would add nothing on planar faces.

## Measurements that would flip a decision

| Measured on the two-storey fixture | Threshold | Flip to |
| --- | --- | --- |
| E per condition, native, M4 | ≤ 20 ms (≈ 100 ms in Wasm on a mid-range laptop at ×5) | keep: synchronous call on the main thread |
| same | 20–60 ms | move `light` into a Web Worker that precomputes the chosen month's daylight steps (≤ 29) in the background; the overlay key check becomes the stale gate |
| same | > 60 ms, or a whole day > 3 s | (a): Container calls the same crate, and #204 adds a result stream; the original split comes back |
| E misses any pre-registered tolerance, or loses a slit | any miss | first fix the sliver thresholds; if it still fails, the Container with `planar_regions_boolean`. Q is not a fallback (see above). |
| B vs mesh-ray disagreement on planar faces | > 1 % of area | make the B-rep the truth, which means the Container |
| Overlay triangles per condition | > 20,000 | merge pieces per face before building the overlay |
| `pv_slot` upload + draw per step | > 4 ms, or ground/AO artifacts from the preview slot | put the overlay into the main scene and measure the cost of rebuilding `scene_geometry` |
| Viewer Wasm size growth | > 150 KB gzip | look at the index first; it is the likely bulk |

## Open questions and risks

- Is the speed of the salesperson's device acceptable as the latency bound, or must the time-change response be guaranteed on, say, a 2019 iPad? The flip table assumes ×5 from M4.
- Should revisions saved before `SITE`/`RECV` get their display data regenerated from the snapshot, or is "unavailable" acceptable before invited users arrive?
- Using `pv_slot` borrows a slot named for live previews. Does viewport-gpu's ground effect (`preview_bounds`) react to it in a way we would see?
- Should `RECV` include the window reveal faces (#210's open point)? The method handles them without change.

## Next implementation step

Write `crates/sunlight/src/clip.rs` (convex piece minus triangle, sliver drop, budget) with the floor, wall, sloped-ceiling and slit fixtures as unit tests on hand-built triangle sets. It is the load-bearing piece, and it does not wait on any other issue.

## Type sketch

```rust
// Candidate 2 type sketch. Three crates shown as inline modules for reading; paths in headers.
// Bodies are todo!(); invariants are in doc comments and types.

// ============================================================================================
// crates/display/src/site.rs and receivers.rs  (#204: optional sections, no version bump)
// ============================================================================================
pub mod display_additions {
    use madori_display::ElementId;

    /// `SITE` optional section. Written by modeling from house data (#189). Absent in display
    /// bytes written before this section existed: the viewer then reports sunlight unavailable.
    /// Invariants checked on decode: finite, |lat| <= 90, |lon| <= 180, |utc_offset| <= 14 h,
    /// north_azimuth in [0, 360).
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct Site {
        lat_deg: f64,
        lon_deg: f64,
        utc_offset_min: i16,
        /// Angle from house +Y to true north, clockwise seen from above.
        north_azimuth_deg: f64,
    }
    impl Site {
        pub fn new(lat_deg: f64, lon_deg: f64, utc_offset_min: i16, north_azimuth_deg: f64) -> Result<Self, SiteError> { todo!() }
    }
    #[derive(Debug, Clone, PartialEq)]
    pub enum SiteError { NonFinite, OutOfRange }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
    pub enum ReceiverKind { Floor, Wall, Ceiling }

    /// One face that can show sunlight. `body` indexes `DisplayModel::bodies`, `face` is a value
    /// that occurs in that body's TFAC. Decode rejects out-of-range body, absent face, duplicates.
    #[derive(Debug, Clone, PartialEq)]
    pub struct Receiver { pub body: u32, pub face: u32, pub kind: ReceiverKind, pub room: ElementId }

    /// `RECV` optional section, sorted by (body, face) so re-encoding is canonical.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct Receivers(Vec<Receiver>);
    impl Receivers {
        pub fn new(entries: Vec<Receiver>) -> Result<Self, madori_display::ModelError> { todo!() }
        pub fn iter(&self) -> impl ExactSizeIterator<Item = &Receiver> { self.0.iter() }
    }

    // DisplayModel gains: `pub fn site(&self) -> Option<Site>` and `pub fn receivers(&self) -> &Receivers`,
    // and its constructor takes them (Option / empty default). Future: `LTRN` light-transmitting
    // bodies, added with the first glass body. Every body not listed there occludes.
}

// ============================================================================================
// crates/sunlight  (madori-sunlight; depends on madori-display only)
// ============================================================================================
pub mod sunlight {
    use super::display_additions::{ReceiverKind, Site};
    use madori_display::{DisplayModel, ElementId};

    // ---- sun.rs (#201 lands here) -----------------------------------------------------------

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub struct Month(u8); // 1..=12
    impl Month { pub fn new(m: u8) -> Result<Self, ConditionError> { todo!() } }

    /// 30-minute step of the local day: 0 = 00:00 .. 47 = 23:30.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub struct HalfHour(u8);
    impl HalfHour { pub fn new(slot: u8) -> Result<Self, ConditionError> { todo!() } }

    /// What the user picked. The day is fixed to the 21st (plan 2.3).
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub struct SunCondition { pub year: u16, pub month: Month, pub slot: HalfHour }
    impl SunCondition {
        pub fn new(year: u16, month: Month, slot: HalfHour) -> Result<Self, ConditionError> { todo!() }
    }
    #[derive(Debug, Clone, PartialEq)]
    pub enum ConditionError { Month(u8), Slot(u8), Year(u16) }

    /// Sun as seen from the house frame (+X east, +Y north before north_azimuth, +Z up).
    /// The direction is quantized to a 2^-30 grid at construction so native and wasm32 feed
    /// identical bits to the geometry (sin/cos may differ by an ulp between libms).
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct SunPosition { toward_sun: [f64; 3], altitude_deg: f64, key: SunKey }

    /// Memo / identity key. Equal keys give bit-identical `Sunlight`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
    pub struct SunKey { quantized: [i64; 3] }

    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct Deg(pub f64);
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub struct Azimuth(pub Deg); // clockwise from true north
    impl Azimuth { pub const SOUTH: Azimuth = Azimuth(Deg(180.)); }

    impl SunPosition {
        /// NOAA approximation, no refraction (#201 documents the azimuth-sign pitfall).
        pub fn at(site: Site, condition: SunCondition) -> SunPosition { todo!() }
        /// Fixtures and tests: altitude and azimuth already in the site's true-north frame
        /// with north_azimuth = 0.
        pub fn from_angles(altitude: Deg, azimuth: Azimuth) -> SunPosition { todo!() }
        pub fn below_horizon(&self) -> bool { self.altitude_deg <= 0. }
        pub fn key(&self) -> SunKey { self.key }
    }

    // ---- lib.rs: the public computation ----------------------------------------------------

    /// Per-model preparation: f64 occluder triangles (every body, hidden roof included — this
    /// type never sees viewer visibility), receiver triangles with inward normals, closed-body
    /// flags for back-face culling. Built once per shown display model.
    pub struct SunScene { site: Site /* + private: occluders, receivers */ }

    #[derive(Debug, Clone, PartialEq)]
    pub enum PrepareError {
        /// The display bytes predate SITE/RECV: sunlight is unavailable for this revision.
        MissingSite,
        NoReceivers,
        TooManyOccluders { triangles: usize, limit: usize },
    }

    /// Work budget counted in operations, not time: the same model passes or fails everywhere.
    #[derive(Debug, Clone, Copy)]
    pub struct Budget { pub clips: u64, pub pieces: u32 }
    impl Budget { pub const DEFAULT: Budget = Budget { clips: 4_000_000, pieces: 65_536 }; }

    #[derive(Debug, Clone, PartialEq)]
    pub enum LightError { TooComplex { receiver: u32, clips: u64, pieces: u32 } }

    /// Night is not "no patches": the UI must tell them apart.
    #[derive(Debug, Clone, PartialEq)]
    pub enum Sunlight {
        BelowHorizon { sun: SunPosition },
        Lit { sun: SunPosition, patches: Vec<LitPatch> },
    }

    /// Lit part of one receiver face. Triangles are the convex pieces fanned, in world f32,
    /// lying on the receiver plane (the viewer applies the 1 mm offset). Empty faces are omitted.
    #[derive(Debug, Clone, PartialEq)]
    pub struct LitPatch {
        pub receiver: u32, // index into RECV
        pub kind: ReceiverKind,
        pub room: ElementId,
        pub normal: [f32; 3],
        pub triangles: Vec<[[f32; 3]; 3]>,
        pub area_mm2: f64, // summed in f64 from the pieces, before f32 conversion
    }

    impl SunScene {
        pub fn prepare(model: &DisplayModel) -> Result<SunScene, PrepareError> { todo!() }
        pub fn site(&self) -> Site { self.site }
        pub fn light(&self, sun: &SunPosition) -> Result<Sunlight, LightError> {
            self.light_within(sun, Budget::DEFAULT)
        }
        pub fn light_within(&self, sun: &SunPosition, budget: Budget) -> Result<Sunlight, LightError> {
            // if sun.below_horizon() { return Ok(BelowHorizon) }   — no geometry touched
            // index = LightGrid::build(occluders, s)                  — index.rs, per direction
            // for each receiver triangle R:
            //   if n_R · s <= 0 { dark; continue }                   — horizontal ceiling = 0 exactly
            //   cands = index.query(R) filtered to front-facing, sun side of R's plane
            //   sort cands by projected overlap area, descending
            //   lit = [R as convex piece]
            //   for T in cands: lit = clip::subtract(lit, project(T, R, s), &mut counter)?;
            //                   if lit.is_empty() { break }
            //   drop slivers (area < 1e-2 mm² or width < 1e-3 mm)
            // group pieces by receiver face -> LitPatch
            todo!()
        }
    }

    impl Sunlight {
        pub fn area_m2(&self, kind: ReceiverKind) -> f64 { todo!() }
        pub fn area_m2_in(&self, room: &ElementId, kind: ReceiverKind) -> f64 { todo!() }
    }

    // ---- private modules (not reachable from outside the crate) ----------------------------
    mod index { /* LightGrid: occluder triangles projected onto plane ⟂ s, uniform grid */ }
    mod clip {
        /// Convex polygon in a receiver plane's 2D frame.
        pub(super) struct Piece(pub Vec<[f64; 2]>);
        /// piece − triangle = at most three convex pieces (split by T's edge half-planes).
        /// Counts one clip per half-plane test; errors when the budget is crossed.
        pub(super) fn subtract(lit: Vec<Piece>, t: [[f64; 2]; 3], counter: &mut super::Counter) -> Result<Vec<Piece>, super::LightError> { todo!() }
    }
    struct Counter { clips: u64, budget: Budget }
}

// ============================================================================================
// crates/modeling/src/display/receivers.rs  (#205 floors, #210 walls and ceilings)
// ============================================================================================
pub mod modeling_entry {
    use super::display_additions::{Receivers, Site};

    /// What modeling adds to the display export so the browser can compute sunlight.
    pub struct SunInputs { pub site: Site, pub receivers: Receivers }

    #[derive(Debug)]
    pub enum ReceiverError {
        /// A room's floor top face could not be resolved from the face roles.
        UnresolvedFloor { room: String },
        UnresolvedCeiling { room: String },
    }

    /// Receiver faces from face roles (3.5), never from display names or face numbers kept
    /// across requests: floor top faces of each room body; wall faces whose role is a room;
    /// downward-facing faces of upper floor bodies and roof bodies over a room. Exterior faces
    /// and roof tops are not receivers.
    pub fn receivers(
        session: &solidcraft_engine::Session,
        map: &crate::model::Mapping, // the per-request correspondence table
    ) -> Result<Receivers, ReceiverError> { todo!() }

    // display::export grows one parameter:
    // pub fn export(session: &Session, elements: &BodyElements, sun: &SunInputs)
    //     -> Result<DisplayModel, ExportError>;
    //
    // Production modeling does NOT depend on madori-sunlight. Tests do (dev-dependency):
    //   let scene = madori_sunlight::SunScene::prepare(&export_house(&house)?)?;
    //   let lit = scene.light(&SunPosition::from_angles(Deg(30.), Azimuth::SOUTH))?;
    //   assert_close(lit.area_m2(ReceiverKind::Floor), 2.046307, 0.020463);
    // Fallback (flip to Container): modeling calls the same crate and #204 encodes `Sunlight`.
}

// ============================================================================================
// crates/viewer/src/sunlight.rs and gpu.rs  (#209)
// ============================================================================================
pub mod viewer_entry {
    use super::sunlight::{SunKey, SunScene, Sunlight};
    use std::collections::HashMap;

    /// Returned to the web for the caption and badges. No geometry crosses to JS.
    #[derive(Debug, Clone)]
    pub struct SunlightSummary {
        pub available: bool,      // false: display bytes have no SITE/RECV
        pub below_horizon: bool,
        pub year: u16, pub month: u8, pub day: u8, pub hhmm: String, // the computed local time
        pub floor_m2: f64, pub wall_m2: f64, pub ceiling_m2: f64,
    }

    #[derive(Debug, Clone, Copy)]
    pub enum SunlightFailure { TooComplex, InvalidCondition }

    /// Per shown model. Dropped by `Viewer::show` so nothing outlives its revision.
    pub(crate) struct SunState {
        scene: Option<SunScene>,                 // lazily prepared
        memo: HashMap<SunKey, Sunlight>,         // bounded to 96 entries, LRU
        overlay: Option<Overlay>,
    }

    /// Lit patches as one viewport Scene in the pv_slot: opaque warm yellow, offset 1 mm along
    /// the receiver normal, tri_face = receiver ordinal (outlines only at lit-region edges).
    pub(crate) struct Overlay { pub scene_key: u64, pub pv_key: u64 /* + SceneSlot */ }
    impl Overlay {
        pub(crate) fn build(scene_key: u64, lit: &Sunlight) -> Option<Overlay> { todo!() }
    }

    // In gpu.rs, on #[wasm_bindgen] impl Viewer:
    // pub fn show_sunlight(&mut self, year: u16, month: u8, slot: u8)
    //     -> Result<SunlightSummary, Failure>;
    //   condition -> SunPosition::at(scene.site(), ..) -> memo or scene.light -> Overlay::build
    //   draw(): uses overlay only if overlay.scene_key == self.key (the stale gate)
    // pub fn clear_sunlight(&mut self);
    // Roof / upper-floor visibility toggles rebuild the model scene only; SunState is untouched.
}
```
