# instant-madori: agent instructions

This repository builds a browser-based housing consultation service using SolidCraft. Start with [README.md](README.md), [current status](docs/status.md), and the [implementation plan](docs/plan.md). Read the relevant plan section before changing behavior.

## Collaboration

- Discussion, review, and design questions are not instructions to edit files. Carry out explicit implementation requests within their agreed scope.
- Preserve the user's work. Check Git status and history before changing the repository; do not reset unrelated changes.
- Distinguish agreed requirements, implementation choices, and observations. Do not describe a planned or compiled feature as tested behavior.
- Keep documentation consistent with decisions. Product documentation and discussion may be Japanese; code identifiers and comments use English.
- Keep explanations at the user's level of abstraction, and group only comparable items. Do not use the term 「正本」.

## Boundaries

- `apps/web` and `apps/worker`: TypeScript. `apps/geometry` and `crates/*`: Rust. `packages/contracts`: shared web/API schemas and generated Rust-facing contracts.
- `crates/housing` has no HTTP, browser, Cloudflare, or CAD dependency. `crates/modeling` connects housing data to SolidCraft; `crates/viewer` uses only its rendering layers.
- `third_party/solidcraft` retains upstream source, assets, licenses, and instructions. Honor its technical constraints when patching that code. Its Rust-only, product-name, English-docs, and UI rules do not govern the surrounding service. Upstream contribution procedures (claims, draft PRs, and the entire upstream CI suite) are for contributing upstream; local integration patches use relevant checks and the service checks described here.
- Do not delete unused upstream components. Update through git subtree as described in [third_party/solidcraft.md](third_party/solidcraft.md), never by merging upstream into the repository root.
- Incorporate upstream updates by default. Check compatibility with this service; adapt or document a specific deferral when an update conflicts with it. Keep upstream changes separate from service changes.
- Preserve third-party notices and licenses. Do not introduce GPL/LGPL/AGPL dependencies or copy other products' code or assets.
- Do not introduce production credentials or deploy infrastructure as part of local environment work.

## Checks and handoff

- Use the pinned tools through mise and the commands in README. `pnpm check --fast` autofixes and checks TypeScript and Rust; `pnpm check` also runs both test suites. Use `pnpm check --full` for builds, local integration and dependency audits, including after dependency, upstream or Wasm API changes. Checks run locally; do not depend on GitHub Actions. Run the checks relevant to a change before committing; never claim checks that were not run.
- Keep TypeScript apps and scripts under type-aware ESLint and strict type checking. Parse untrusted JSON at its boundary. Keep dependency catalogs and tool pins consistent; review lockfile changes.
- All `pnpm check` modes format service files and apply automatic ESLint/Clippy fixes; review the resulting diff before staging. Do not bulk-format upstream source, historical verification records, or generated files. Pre-commit hooks check staged files without rewriting them; they do not replace whole-project checks.
- New non-test Rust must avoid `unsafe`, `unwrap`, `expect`, and panic-based error handling. Validate external input at its boundary.
- Test behavior and meaningful integration boundaries, not mechanical wrappers. Leave generated Wasm output and build caches untracked.
- Update `docs/status.md` when a stage finishes: what works, what was actually checked, remaining limitations, and the next step. Update `docs/plan.md` when requirements or architecture change.
- Commit and deployment are separate actions. Do not push or deploy without authorization.
