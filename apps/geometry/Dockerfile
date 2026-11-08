FROM rust:1.99.1-bookworm AS build
WORKDIR /app
COPY . .
RUN cargo build --locked --release -p madori-geometry

FROM debian:bookworm-slim
RUN groupadd --system --gid 10001 madori \
    && useradd --system --uid 10001 --gid madori --create-home madori
COPY --from=build /app/target/release/madori-geometry /usr/local/bin/madori-geometry
USER 10001:10001
ENV MADORI_GEOMETRY_BIND=0.0.0.0:3001
EXPOSE 3001
CMD ["madori-geometry"]
