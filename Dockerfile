# Demo/stopgap image: one always-on Bun process, SQLite + blobs on the
# container disk. WITHOUT a mounted volume at /app/data everything resets on
# restart/redeploy — fine for a demo, not for real use. Attach a persistent
# disk (or move to the real deployment system + S3) before relying on it.
FROM oven/bun:1 AS build
WORKDIR /app

# Server deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Web deps + build
COPY web/package.json web/bun.lock* ./web/
RUN cd web && bun install
COPY . .
RUN cd web && bun run build

FROM oven/bun:1
WORKDIR /app
COPY --from=build /app /app

# Render/Railway inject PORT; the server reads env.PORT (defaults to 4500).
EXPOSE 4500

# Boot: seed the admin once (no-op if the user already exists; the one-time
# login code is printed to the container logs on first boot), then serve.
CMD ["sh", "-c", "bun run scripts/seed.ts && bun run src/server.ts || bun run src/server.ts"]
