# Arena task: pattern display design for instant-madori (issue #173)

## The user's goal
Decide how the service's browser 3D viewer draws wood-grain floors and tile walls at their real-world repeat size and orientation, and how pattern coordinates are assigned to faces, so that the follow-up issues can be built on one decided route:
- #174 adds an optional MDSP display-data section for the material table and per-face pattern projection (crates/display).
- #176 writes materials from modeling into the display data (crates/modeling) and handles material operations.
- #179 makes the display pattern image from a user's photo, stores it apart from the original, once per original (place to be decided here: Container, Worker or browser).
- #181 draws the patterns in crates/viewer and caches pattern images across plan switches (web fetch dedupe + GPU texture cache keyed by content hash).
Read `gh issue view 173`, `gh issue view 174`, `gh issue view 179`, `gh issue view 181` (run them with the gh CLI) and docs/plan.md sections 3.3, 3.5, 4.2, 4.3, 4.4, 4.7, 4.8, 5.2, 6.4, 6.5.

## What to produce (one candidate design package)
Decide each of these, with the caller's usage first, then types and signatures with `todo!()` bodies, then the rationale per the template:
1. Route: where the textured draw lives. (A) a viewer-owned pipeline in crates/viewer drawn after SolidCraft's Renderer::paint into the same depth buffer, or (B) a per-face base-colour map inside third_party/solidcraft/crates/viewport-gpu, or a better shape you can justify. If B, say whether it should be offered upstream as a contribution, and what the local patch's public surface is.
2. Coordinate rule: the frame each patterned face gets (origin, u, v in mm, one repeat each), and how it is derived from housing data for walls (both sides), floors, ceilings, and furniture/object faces, so that moving, stretching and splitting walls keeps tile size and keeps tiles continuous across split pieces. Say who computes it (modeling at export, or the viewer) and what invariants are checked where.
3. Representation in display data: planar frame per face computed in the shader from world position, versus per-vertex UVs stored in MDSP. Sketch the MDSP optional section(s): names, record layout, validation, how an old viewer falls back to plain colour, size cost for a large house (the internal limit is 16 MiB).
4. Faces parallel to the projection (furniture cylinder legs, arch openings): planar, triplanar/box projection, or something else, and where that choice is encoded.
5. Mipmaps: generated where (Container and stored, viewer CPU in wasm, viewer GPU pass), with the format and filtering (sRGB-correct averaging), and anisotropy.
6. Image flow: where the display pattern is made from the original (decode, EXIF orientation, colour space, resize to a max edge, maybe a fixed square for a texture array), which process returns bytes and which writes R2, the R2 key and D1 record, how the viewer receives it (route, owner check, caching under plan 4.7's no-store rule), what the wasm API takes (RGBA bytes, ImageBitmap via copy_external_image_to_texture, encoded PNG), and the cache units (R2, web fetch, GPU texture).
7. Sun shadows (plan 6.5): can the chosen route host the shadow term later, and what would that look like.

## Grounding (read all before designing)
- 0-explanation.md (synthesis; start here)
- the three explorer reports 1-*.md, 2-*.md, 3-*.md in the same folder (file:line facts).
A throwaway browser prototype of both routes is being built in parallel and will measure release Wasm size, frame time, and the glass/offscreen behaviour. Its results are not available to you. In your package, name the prototype observations that would change your design (for example "if B's frame time at 8x8 rooms is more than X ms above plain colour, I would ...").

## Constraints that bind every candidate
- Service AGENTS.md (repository root): crate boundaries, no unwrap/expect/panic in new non-test Rust, external input validated where received, third_party/solidcraft changes follow upstream technical constraints and are recorded in third_party/solidcraft.json localPatches and third_party/solidcraft.md.
- The viewer wasm may depend only on solidcraft-geom, -viewport, -viewport-gpu among SolidCraft crates (scripts/check/boundaries.ts viewer-solidcraft row); changing that needs plan 4.2 and the table changed together.
- Plan 5.2: the Worker does not decode or resize images.
- Housing face identity: B-rep face numbers (TFAC) are per artifact and never persistent identities.

Return the whole package as your final message. Do not edit any file in the repository. Do not start builds that write into the repository.
