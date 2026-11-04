import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "../scripts/embed-migrations.ts";

describe("embedded migrations", () => {
  test("src/migrations.generated.ts matches migrations/*.sql (run `bun run embed:migrations`)", () => {
    const onDisk = readFileSync(join(import.meta.dir, "migrations.generated.ts"), "utf8");
    expect(onDisk).toBe(render());
  });
});
