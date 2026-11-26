# Rubric for the pattern display design (issue #173)

Score each criterion 1-5 for each candidate, with one or two sentences of evidence quoted from the candidate.

1. Pattern correctness by construction: real repeat size and orientation; tiles unchanged when a wall moves or stretches; continuous across collinear split pieces; no sign flip after a split or merge; where each invariant is checked.
2. Robustness across render paths with one shading path: glass/OIT/offscreen frames, ssaa != 1, AO, and a future sun-shadow term all stay correct on patterned faces.
3. Upstream and boundary cost: size and placement of the SolidCraft patch (which upstream crates it touches), merge-conflict exposure, compliance with the service rules (viewer may depend only on geom/viewport/viewport-gpu; local patches recorded; plan 4.2).
4. Data shape: minimal display-data section, a single source of truth for colour and frames, validation at decode, fallback for old viewers and missing images, size against the 16 MiB internal limit.
5. Image flow and caches: plan 5.2 (no Worker decode, server does not trust UI-processed images), 4.3 (Container returns bytes, Worker writes R2), 4.4 (owner check), 4.7 (no-store), EXIF/ICC/limits; content-addressed, idempotent creation; no refetch or GPU re-upload when switching plans.
6. Interface depth and reader load for the implementers of #174 (display section), #176 (modeling export), #179 (pattern image), #181 (viewer drawing and caches).

Then recommend a base candidate, list what to graft from the other, and name any claim in either candidate you believe is factually wrong about the code (check the repository when in doubt).
