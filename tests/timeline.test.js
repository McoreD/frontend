import { describe, expect, test } from "vitest";

import {
  buildTimeline,
  countByDay,
  humanReadableDuration,
  placeName,
} from "@/timeline";

// Roughly 0.001 degrees latitude = 111 m.
const HOME = { lat: 52.52, lon: 13.405 };
const WORK = { lat: 52.55, lon: 13.405 }; // ~3.3 km north
const T0 = 1700000000;
const at = (place, minutes, extra = {}) => ({
  ...place,
  tst: T0 + minutes * 60,
  ...extra,
});

describe("buildTimeline", () => {
  test("no locations", () => {
    expect(buildTimeline([])).toEqual([]);
  });

  test("stay, move, stay", () => {
    const segments = buildTimeline([
      at(HOME, 0, { inregions: ["Home"] }),
      at(HOME, 30, { inregions: ["Home"] }),
      at({ lat: 52.53, lon: 13.405 }, 40),
      at({ lat: 52.54, lon: 13.405 }, 45),
      at(WORK, 50, { inregions: ["Work"] }),
      at(WORK, 120, { inregions: ["Work"] }),
    ]);
    expect(segments.map((s) => s.type)).toEqual(["stay", "move", "stay"]);
    expect(segments[0].place).toBe("Home");
    expect(segments[0].end - segments[0].start).toBe(30 * 60);
    expect(segments[1].start).toBe(segments[0].end);
    expect(segments[1].end).toBe(segments[2].start);
    expect(segments[1].distance).toBeGreaterThan(3000);
    expect(segments[1].distance).toBeLessThan(3600);
    expect(segments[2].place).toBe("Work");
    expect(segments[2].endIsLast).toBe(true);
  });

  test("sparse points with a long gap still count as a stay", () => {
    // Significant-change mode: one report at home, next one hours later.
    const segments = buildTimeline([at(HOME, 0), at(WORK, 180), at(WORK, 200)]);
    expect(segments.map((s) => s.type)).toEqual(["stay", "move", "stay"]);
    // Left home about as long before arriving as 3.3 km takes at 30 km/h.
    expect(segments[0].end).toBeGreaterThan(T0 + 170 * 60);
    expect(segments[0].end).toBeLessThan(T0 + 175 * 60);
  });

  test("drops inaccurate locations", () => {
    const segments = buildTimeline([
      at(HOME, 0),
      at(WORK, 5, { acc: 5000 }),
      at(HOME, 30),
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("stay");
    expect(segments[0].count).toBe(2);
  });

  test("unsorted input is handled", () => {
    const segments = buildTimeline([at(HOME, 30), at(HOME, 0)]);
    expect(segments[0].start).toBe(T0);
    expect(segments[0].end).toBe(T0 + 30 * 60);
  });
});

describe("placeName", () => {
  test("prefers the most common region, then poi, then address", () => {
    expect(
      placeName([
        { inregions: ["A"] },
        { inregions: ["B", "A"] },
        { poi: "Cafe" },
      ])
    ).toBe("A");
    expect(placeName([{ addr: "Main St" }, { poi: "Cafe" }])).toBe("Cafe");
    expect(placeName([{ addr: "Main St" }])).toBe("Main St");
    expect(placeName([{}])).toBe(null);
  });
});

describe("countByDay", () => {
  test("groups by local day", () => {
    const counts = countByDay([at(HOME, 0), at(HOME, 1), at(HOME, 60 * 24)]);
    expect(Object.values(counts)).toEqual([2, 1]);
  });
});

describe("humanReadableDuration", () => {
  test("minutes and hours", () => {
    expect(humanReadableDuration(0)).toBe("0 min");
    expect(humanReadableDuration(35 * 60)).toBe("35 min");
    expect(humanReadableDuration(125 * 60)).toBe("2 h 05 min");
  });
});
