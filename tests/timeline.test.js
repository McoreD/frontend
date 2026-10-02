import { describe, expect, test } from "vitest";

import {
  addressLabel,
  buildTimeline,
  coordinateKey,
  countByDay,
  humanReadableDuration,
  nearestRegion,
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

describe("regions", () => {
  const regions = [
    { desc: "Home", lat: HOME.lat, lon: HOME.lon, rad: 50 },
    { desc: "Work", lat: WORK.lat, lon: WORK.lon, rad: 50 },
  ];

  test("names stays without inregions from the nearest region", () => {
    const segments = buildTimeline(
      [at(HOME, 0), at(HOME, 30), at(WORK, 60), at(WORK, 120)],
      { regions }
    );
    expect(
      segments.filter((s) => s.type === "stay").map((s) => s.place)
    ).toEqual(["Home", "Work"]);
  });

  test("inregions from the app wins over the distance match", () => {
    const segments = buildTimeline(
      [at(HOME, 0, { inregions: ["Flat"] }), at(HOME, 30)],
      { regions }
    );
    expect(segments[0].place).toBe("Flat");
  });

  test("radius plus margin, nearest wins", () => {
    // ~111 m north of Home
    const near = { lat: HOME.lat + 0.001, lng: HOME.lon };
    expect(nearestRegion(near, regions, 100)).toBe("Home");
    expect(nearestRegion(near, regions, 50)).toBe(null);
    expect(nearestRegion(near, [], 100)).toBe(null);
    expect(nearestRegion(near, [{ desc: "Bad" }], 100)).toBe(null);
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

describe("addressLabel", () => {
  test("named places, streets, areas and fallbacks", () => {
    expect(
      addressLabel({ name: "Kings Park", address: { suburb: "West Perth" } })
    ).toBe("Kings Park, West Perth");
    expect(
      addressLabel({
        name: "",
        address: { house_number: "12", road: "Hay Street", suburb: "Subiaco" },
      })
    ).toBe("12 Hay Street, Subiaco");
    expect(addressLabel({ address: { suburb: "Subiaco" } })).toBe("Subiaco");
    expect(addressLabel({ display_name: "A, B, C, D" })).toBe("A, B");
    expect(addressLabel({ error: "Unable to geocode" })).toBe(null);
    expect(addressLabel(null)).toBe(null);
  });

  test("coordinateKey rounds to 4 decimals", () => {
    expect(coordinateKey({ lat: -31.953512, lng: 115.857048 })).toBe(
      "-31.9535,115.8570"
    );
  });
});
