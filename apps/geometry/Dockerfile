# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM rust:1.99.1-bookworm AS build
ARG BUILDPLATFORM
ARG TARGETPLATFORM
WORKDIR /src
COPY rust-toolchain.toml ./
# Pinning Debian packages would prevent security updates in fresh image builds.
# hadolint ignore=DL3008
RUN if [ "$TARGETPLATFORM" != "linux/amd64" ]; then echo "Unsupported target: $TARGETPLATFORM (expected linux/amd64)" >&2; exit 1; fi \
    && if [ "$BUILDPLATFORM" != "$TARGETPLATFORM" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends gcc-x86-64-linux-gnu libc6-dev-amd64-cross \
        && rm -rf /var/lib/apt/lists/*; fi \
    && rustup target add x86_64-unknown-linux-gnu
COPY Cargo.toml Cargo.lock ./
COPY .cargo .cargo
COPY apps/geometry apps/geometry
COPY crates crates
COPY third_party/solidcraft third_party/solidcraft
WORKDIR /app
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
# Every checkout and the runner share one target/. Cargo rebuilds a path crate when a source file is newer than its
# last compile, and COPY keeps each checkout's file times, so building /src directly recompiles identical crates for
# a newer checkout and reuses another checkout's crates for an older one. The cache keeps a copy of the sources next
# to target/ and rewrites only the entries whose content differs, so a file's time in the copy is when its content
# arrived. The copy and target/ share one cache record, so pruning removes both together, and sharing=locked gives
# them to one build at a time. Change the id when this layout or the copying changes, so that builds from branches
# with an older Dockerfile do not use the same cache.
# Cargo records each source by its canonical path, so it watches the target a symlink had at compile time.
# The copy therefore contains only files and directories and omits links whose targets are missing.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,id=instant-madori-geometry-build-v2,target=/app,sharing=locked \
    <<'EOF'
export LC_ALL=C
no_hash=$(printf '%064d' 0)
# One NUL-terminated record per entry under $1 except target/: kind (d or f), 64-character content hash, two spaces, path.
entries() {
    find -L "$1" -mindepth 1 -path "$1/target" -prune -o -type d -printf "d$no_hash  %P\0"
    find -L "$1" -path "$1/target" -prune -o -type f -print0 | xargs -0r sha256sum -z | sed -z "s|^|f|; s|  $1/|  |"
}
entries /src | sort -z > /tmp/wanted
entries /app | sort -z > /tmp/present
comm -z -13 /tmp/wanted /tmp/present | cut -z -c68- > /tmp/removed
comm -z -23 /tmp/wanted /tmp/present | cut -z -c68- > /tmp/written
sed -z 's|^|/app/|' /tmp/removed | xargs -0r rm -rf --
tar -C /src --null --verbatim-files-from --no-recursion --dereference -T /tmp/written -cf - | tar -C /app -xmf -
written=$(tr -cd '\0' < /tmp/written | wc -c)
echo "Source copy: removed $(tr -cd '\0' < /tmp/removed | wc -c), wrote $written entries"
if [ "$written" -le 20 ]; then tr '\0' '\n' < /tmp/written; fi
if [ "$BUILDPLATFORM" != "$TARGETPLATFORM" ]; then
    export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc
fi
cargo build --locked --release -p madori-geometry --target x86_64-unknown-linux-gnu
cp target/x86_64-unknown-linux-gnu/release/madori-geometry /madori-geometry
EOF

FROM debian:bookworm-slim
RUN groupadd --system --gid 10001 madori \
    && useradd --system --uid 10001 --gid madori --create-home madori
COPY --from=build /madori-geometry /usr/local/bin/madori-geometry
USER 10001:10001
ENV MADORI_GEOMETRY_BIND=0.0.0.0:3001
EXPOSE 3001
CMD ["madori-geometry"]
