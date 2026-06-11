import { describe, expect, test } from "bun:test";
import {
  daysBetween,
  durationStats,
  editDistanceRatio,
  isoWeek,
  levenshtein,
  median,
  percentile,
} from "./utils.ts";

describe("levenshtein", () => {
  test("identical strings are distance 0", () => {
    expect(levenshtein("hello world", "hello world")).toBe(0);
    expect(editDistanceRatio("hello world", "hello world")).toBe(0);
  });

  test("classic kitten/sitting is 3", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  test("fully disjoint strings have ratio 1", () => {
    expect(editDistanceRatio("abc", "xyz")).toBe(1);
    expect(editDistanceRatio("", "xyz")).toBe(1);
  });

  test("empty vs empty is 0", () => {
    expect(editDistanceRatio("", "")).toBe(0);
  });
});

describe("isoWeek", () => {
  test("known ISO weeks", () => {
    expect(isoWeek("2026-01-01T00:00:00.000Z")).toBe("2026-W01"); // Thursday
    expect(isoWeek("2026-06-01T12:00:00.000Z")).toBe("2026-W23"); // Monday
    expect(isoWeek("2026-06-07T23:59:59.000Z")).toBe("2026-W23"); // Sunday same week
    expect(isoWeek("2026-06-08T00:00:00.000Z")).toBe("2026-W24");
  });

  test("year-boundary days belong to the right ISO year", () => {
    // 2027-01-01 is a Friday in W53 of 2026
    expect(isoWeek("2027-01-01T00:00:00.000Z")).toBe("2026-W53");
  });
});

describe("stats helpers", () => {
  test("median of even and odd lists", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  test("p90 nearest rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([5], 0.9)).toBe(5);
  });

  test("durationStats on empty input", () => {
    expect(durationStats([])).toEqual({ avg: null, median: null, p90: null, n: 0 });
  });

  test("daysBetween is exact for whole days", () => {
    expect(daysBetween("2026-06-03T00:00:00.000Z", "2026-06-05T00:00:00.000Z")).toBe(2);
  });
});
