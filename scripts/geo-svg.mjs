/**
 * Shared by scripts/gen-country-maps.mjs and scripts/gen-region-maps.mjs:
 * turns one GeoJSON feature into a flat-filled SVG thumbnail, the way the XD
 * map thumbnails look.
 *
 * Each shape is projected on its own (Mercator centred on it, so Russia and
 * Fiji do not split across the antimeridian), polygons far from its main body
 * are dropped (Alaska, French Guiana), and islands too small to see at
 * thumbnail size go too.
 *
 * Features must use d3's winding (outer rings clockwise). world-atlas already
 * does; plain GeoJSON (RFC 7946) is the other way round — pass it through
 * `@mapbox/geojson-rewind` with `clockwise = true` first.
 */
import {
  geoArea,
  geoCentroid,
  geoDistance,
  geoMercator,
  geoPath,
} from "d3-geo";

/** SVG units per XD px — enough precision at 2x/3x screens, small files. */
const SCALE = 10;
/** Widest sea gap a shape may span, coast to coast (radians). */
const MAX_GAP = (5 * Math.PI) / 180;

/** Up to ~150 points of a polygon's outer ring — enough to measure gaps. */
function sample(ring) {
  const step = Math.max(1, Math.floor(ring.length / 150));
  return ring.filter((_, i) => i % step === 0);
}

/**
 * Keep the largest polygon and every polygon reachable from it in hops of at
 * most MAX_GAP — so an archipelago (Indonesia, Japan) stays whole while a
 * distant territory (Alaska, the Canaries, French Guiana) drops out.
 */
function mainBody(f) {
  if (f.geometry.type !== "MultiPolygon") return f;
  const polys = f.geometry.coordinates.map((coordinates) => ({
    coordinates,
    area: geoArea({ type: "Polygon", coordinates }),
    points: sample(coordinates[0]),
  }));
  const main = polys.reduce((a, b) => (b.area > a.area ? b : a));
  const near = (a, b) =>
    a.points.some((p) => b.points.some((q) => geoDistance(p, q) <= MAX_GAP));

  const kept = [main];
  let rest = polys.filter((p) => p !== main);
  for (let grew = true; grew; ) {
    grew = false;
    rest = rest.filter((p) => {
      if (!kept.some((k) => near(k, p))) return true;
      kept.push(p);
      grew = true;
      return false;
    });
  }
  return {
    ...f,
    geometry: {
      type: "MultiPolygon",
      coordinates: kept.map((p) => p.coordinates),
    },
  };
}

/**
 * Drop islands too small to see at thumbnail size (Canada's Arctic is most of
 * its file otherwise). An island nation's islands are all small, so anything
 * within 5% of the largest is kept regardless.
 */
const SPECK = 0.3 * SCALE * SCALE;
function dropSpecks(f, path) {
  if (f.geometry.type !== "MultiPolygon") return f;
  const areas = f.geometry.coordinates.map((coordinates) =>
    path.area({ type: "Feature", geometry: { type: "Polygon", coordinates } }),
  );
  const largest = Math.max(...areas);
  const kept = f.geometry.coordinates.filter(
    (_, i) => areas[i] >= SPECK || areas[i] >= largest * 0.05,
  );
  return { ...f, geometry: { type: "MultiPolygon", coordinates: kept } };
}

/**
 * One feature → `{ svg, w, h }` (w × h in XD px), or null when nothing is
 * left to draw. `boxFor(aspect)` sizes the thumbnail from the shape's
 * width / height.
 */
export function renderThumb(raw, { fill, boxFor }) {
  if (!raw.geometry) return null;
  const f = mainBody(raw);
  const [lon] = geoCentroid(f);
  // Measure the shape's aspect at an arbitrary scale, then fit it to its box.
  const probe = geoMercator().rotate([-lon, 0]).scale(1000).translate([0, 0]);
  const [[x0, y0], [x1, y1]] = geoPath(probe).bounds(f);
  if (!(x1 > x0 && y1 > y0)) return null;
  const box = boxFor((x1 - x0) / (y1 - y0));
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));

  const size = [w * SCALE, h * SCALE];
  const projection = geoMercator().rotate([-lon, 0]).fitSize(size, f);
  const visible = dropSpecks(f, geoPath(projection));
  const d = geoPath(projection.fitSize(size, visible)).digits(0)(visible);
  if (!d) return null;
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w * SCALE} ${h * SCALE}"><path fill="${fill}" d="${d}"/></svg>\n`,
    w,
    h,
  };
}
