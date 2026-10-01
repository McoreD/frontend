import moment from "moment";

import { distanceBetweenCoordinates } from "@/util";

/**
 * @typedef {Object} TimelineOptions
 * @property {Number} stayRadius
 *   Points within this many meters of a cluster's center belong to the cluster
 * @property {Number} minStayMinutes
 *   A cluster spanning at least this long is a stay rather than part of a move
 * @property {Number} gapMinutes
 *   A silence longer than this before leaving a place counts as time spent
 *   there (apps in significant-change mode report rarely while stationary)
 * @property {Number|null} maxAccuracy
 *   Ignore locations whose reported accuracy (meters) is worse than this
 * @property {Number} travelSpeed
 *   Assumed speed (km/h) for estimating when a stay ended before a silence
 */

/** @type {TimelineOptions} */
export const DEFAULT_TIMELINE_OPTIONS = {
  stayRadius: 150,
  minStayMinutes: 10,
  gapMinutes: 15,
  maxAccuracy: 500,
  travelSpeed: 30,
};

const toLatLng = (l) => ({ lat: l.lat, lng: l.lon });

const centroid = (points) => {
  const sum = points.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lon }),
    { lat: 0, lng: 0 }
  );
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
};

const pathDistance = (latLngs) => {
  let distance = 0;
  for (let i = 1; i < latLngs.length; i++) {
    distance += distanceBetweenCoordinates(latLngs[i - 1], latLngs[i]);
  }
  return distance;
};

/**
 * Pick a human-readable name for a group of locations: the most common
 * region name, then a point of interest, then a reverse-geocoded address.
 *
 * @param {OTLocation[]} points Locations of one stay
 * @returns {String|null} Place name, if any location carries one
 */
export const placeName = (points) => {
  const counts = {};
  points.forEach((p) => {
    (p.inregions || []).forEach((r) => {
      counts[r] = (counts[r] || 0) + 1;
    });
  });
  const regions = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (regions.length) return regions[0];
  const withPoi = points.find((p) => p.poi);
  if (withPoi) return withPoi.poi;
  const withAddr = points.find((p) => p.addr);
  if (withAddr) return withAddr.addr;
  return null;
};

/**
 * Turn a device's locations into a sequence of stays and moves, the way a
 * "day timeline" presents them.
 *
 * @param {OTLocation[]} locations Locations of a single device
 * @param {Partial<TimelineOptions>} [options]
 * @returns {Array<Object>} Segments in chronological order. Stays have
 *   `{ type: "stay", start, end, center, place, count, endIsLast }`, moves have
 *   `{ type: "move", start, end, distance, latLngs }`. Times are unix seconds.
 */
export const buildTimeline = (locations, options = {}) => {
  const opts = { ...DEFAULT_TIMELINE_OPTIONS, ...options };
  const points = locations
    .filter(
      (l) =>
        typeof l.lat === "number" &&
        typeof l.lon === "number" &&
        typeof l.tst === "number" &&
        !(
          opts.maxAccuracy !== null &&
          typeof l.acc === "number" &&
          l.acc > opts.maxAccuracy
        )
    )
    .sort((a, b) => a.tst - b.tst);
  if (points.length === 0) return [];

  // 1. Split into spatial clusters of consecutive points.
  const clusters = [];
  let current = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (
      distanceBetweenCoordinates(centroid(current), toLatLng(p)) <=
      opts.stayRadius
    ) {
      current.push(p);
    } else {
      clusters.push(current);
      current = [p];
    }
  }
  clusters.push(current);

  // 2. Decide which clusters are stays.
  const minStay = opts.minStayMinutes * 60;
  const gap = opts.gapMinutes * 60;
  const classified = clusters.map((cluster, i) => {
    const start = cluster[0].tst;
    let end = cluster[cluster.length - 1].tst;
    const next = clusters[i + 1];
    const isLast = next === undefined;
    // Long silence before the next report elsewhere: we were still here,
    // until roughly the time it takes to get to the next place.
    if (!isLast && next[0].tst - end > gap) {
      const distance = distanceBetweenCoordinates(
        centroid(cluster),
        toLatLng(next[0])
      );
      const travel = Math.max(
        60,
        distance / ((opts.travelSpeed * 1000) / 3600)
      );
      end = Math.max(end, next[0].tst - Math.round(travel));
    }
    // Where the data ends (e.g. home for the night) is a stay too.
    const isStay = end - start >= minStay || isLast;
    return { cluster, start, end, isStay, isLast };
  });

  // 3. Emit stays, merging everything in between into moves.
  const segments = [];
  let pending = [];
  let previousStay = null;
  const flushMove = (nextStay) => {
    if (pending.length === 0 && !(previousStay && nextStay)) return;
    const latLngs = [
      ...(previousStay ? [previousStay.center] : []),
      ...pending.map(toLatLng),
      ...(nextStay ? [nextStay.center] : []),
    ];
    if (latLngs.length < 2) {
      pending = [];
      return;
    }
    const start = previousStay ? previousStay.end : pending[0].tst;
    const end = nextStay ? nextStay.start : pending[pending.length - 1].tst;
    segments.push({
      type: "move",
      start,
      end: Math.max(start, end),
      distance: pathDistance(latLngs),
      latLngs,
    });
    pending = [];
  };
  classified.forEach(({ cluster, start, end, isStay, isLast }) => {
    if (!isStay) {
      pending.push(...cluster);
      return;
    }
    const stay = {
      type: "stay",
      start,
      end,
      center: centroid(cluster),
      place: placeName(cluster),
      count: cluster.length,
      endIsLast: isLast,
    };
    flushMove(stay);
    segments.push(stay);
    previousStay = stay;
  });
  flushMove(null);
  return segments;
};

/**
 * Count locations per local calendar day.
 *
 * @param {OTLocation[]} locations
 * @returns {Object<String, Number>} "YYYY-MM-DD" (browser timezone) to count
 */
export const countByDay = (locations) => {
  const counts = {};
  locations.forEach((l) => {
    const day = moment.unix(l.tst).format("YYYY-MM-DD");
    counts[day] = (counts[day] || 0) + 1;
  });
  return counts;
};

/**
 * Format a duration in seconds as "2 h 05 min" / "35 min".
 *
 * @param {Number} seconds
 * @returns {String}
 */
export const humanReadableDuration = (seconds) => {
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} h ${String(rest).padStart(2, "0")} min`;
};
