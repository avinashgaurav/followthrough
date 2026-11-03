# Self-host image: one always-on Bun process. Needs DATABASE_URL (Postgres);
# the server applies migrations at startup. Files go to Supabase Storage when
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set, otherwise to /app/data/blobs
# (mount a volume there). The main deployment target is Vercel (vercel.json).
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

# Boot: with DEMO_MODE on, seed the fictional demo data into an empty database
# first (all-or-nothing, in one transaction). Then seed the admin once
# (no-op if the user already exists; the one-time login code is printed to the
# container logs on first boot). Seed failures never block the server.
CMD ["sh", "-c", "bun run scripts/seed-demo.ts --if-demo; bun run scripts/seed.ts; exec bun run src/server.ts"]
