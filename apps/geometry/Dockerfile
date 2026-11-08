FROM rust:1.99.1-bookworm AS build
WORKDIR /app
COPY . .
RUN cargo build --locked --release -p madori-geometry

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --create-home madori
COPY --from=build /app/target/release/madori-geometry /usr/local/bin/madori-geometry
USER madori
ENV MADORI_GEOMETRY_BIND=0.0.0.0:3001
EXPOSE 3001
CMD ["madori-geometry"]
