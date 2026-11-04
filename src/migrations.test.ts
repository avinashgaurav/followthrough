import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "../scripts/embed-migrations.ts";
import { APP_MIGRATIONS, CONTROL_MIGRATIONS } from "./migrations.generated.ts";

describe("embedded migrations", () => {
  test("src/migrations.generated.ts matches migrations/*.sql (run `bun run embed:migrations`)", () => {
    const onDisk = readFileSync(join(import.meta.dir, "migrations.generated.ts"), "utf8");
    expect(onDisk).toBe(render());
  });

  test("both lists are non-empty and start with the init migration", () => {
    expect(APP_MIGRATIONS[0]?.name).toBe("001_init.sql");
    expect(CONTROL_MIGRATIONS.length).toBeGreaterThan(0);
  });
});
