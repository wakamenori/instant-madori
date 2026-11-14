# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM rust:1.99.1-bookworm AS build
ARG BUILDPLATFORM
ARG TARGETPLATFORM
WORKDIR /app
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
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/app/target \
    if [ "$BUILDPLATFORM" != "$TARGETPLATFORM" ]; then \
        export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=x86_64-linux-gnu-gcc; fi \
    && cargo build --locked --release -p madori-geometry --target x86_64-unknown-linux-gnu \
    && cp target/x86_64-unknown-linux-gnu/release/madori-geometry /madori-geometry

FROM debian:bookworm-slim
RUN groupadd --system --gid 10001 madori \
    && useradd --system --uid 10001 --gid madori --create-home madori
COPY --from=build /madori-geometry /usr/local/bin/madori-geometry
USER 10001:10001
ENV MADORI_GEOMETRY_BIND=0.0.0.0:3001
EXPOSE 3001
CMD ["madori-geometry"]
