// Pure helpers: format registry, input detection and ogr2ogr argument building.
// No DOM and no GDAL here, so everything is unit tested.

export type FormatId = "geojson" | "kml" | "shapefile" | "csv" | "gpx" | "gpkg";

export interface OutputFormat {
  id: FormatId;
  label: string;
  driver: string;
  ext: string;
  /** Produces several files that are zipped together for download. */
  multiFile: boolean;
  /** Formats that only store WGS84 coordinates. */
  forcesWgs84: boolean;
  mime: string;
}

export const OUTPUT_FORMATS: readonly OutputFormat[] = [
  { id: "geojson", label: "GeoJSON", driver: "GeoJSON", ext: "geojson", multiFile: false, forcesWgs84: false, mime: "application/geo+json" },
  { id: "kml", label: "KML", driver: "KML", ext: "kml", multiFile: false, forcesWgs84: true, mime: "application/vnd.google-earth.kml+xml" },
  { id: "shapefile", label: "Shapefile (zip)", driver: "ESRI Shapefile", ext: "shp", multiFile: true, forcesWgs84: false, mime: "application/zip" },
  { id: "csv", label: "CSV (WKT geometry)", driver: "CSV", ext: "csv", multiFile: false, forcesWgs84: false, mime: "text/csv" },
  { id: "gpx", label: "GPX", driver: "GPX", ext: "gpx", multiFile: false, forcesWgs84: true, mime: "application/gpx+xml" },
  { id: "gpkg", label: "GeoPackage", driver: "GPKG", ext: "gpkg", multiFile: false, forcesWgs84: false, mime: "application/geopackage+sqlite3" },
];

export function outputFormat(id: FormatId): OutputFormat {
  const f = OUTPUT_FORMATS.find((x) => x.id === id);
  if (!f) throw new Error(`unknown format ${id}`);
  return f;
}

export interface NamedFile {
  name: string;
  size?: number;
}

export type InputKind = "geojson" | "kml" | "kmz" | "shapefile" | "shapefile-zip" | "csv" | "gpx" | "gpkg" | "zip";

export interface InputPlan {
  kind: InputKind;
  /** Files to hand to Gdal.open (all of them for a loose shapefile). */
  files: NamedFile[];
  /** VFS handlers for Gdal.open, e.g. ["vsizip"]. */
  vfs: string[];
  /** Base name for output files. */
  baseName: string;
  warnings: string[];
}

const SHP_PARTS = ["shp", "shx", "dbf", "prj", "cpg", "qix", "sbn", "sbx"];

export function extOf(name: string): string {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

export function stem(name: string): string {
  return name.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
}

/** Decide how to open what the user dropped. Throws a readable error if it cannot be opened. */
export function planInput(files: NamedFile[]): InputPlan {
  if (files.length === 0) throw new Error("No file selected.");
  const warnings: string[] = [];
  const exts = files.map((f) => extOf(f.name));

  // Loose shapefile parts: .shp + .dbf (+ .shx, .prj ...)
  if (exts.includes("shp")) {
    const shp = files[exts.indexOf("shp")];
    const base = stem(shp.name).toLowerCase();
    const parts = files.filter((f) => stem(f.name).toLowerCase() === base && SHP_PARTS.includes(extOf(f.name)));
    const have = new Set(parts.map((f) => extOf(f.name)));
    if (!have.has("dbf")) throw new Error(`${shp.name}: the .dbf file is missing (select all shapefile parts together, or a .zip).`);
    if (!have.has("shx")) warnings.push("No .shx file: GDAL will rebuild the index (SHAPE_RESTORE_SHX).");
    if (!have.has("prj")) warnings.push("No .prj file: the coordinate system is unknown, set the source CRS manually.");
    return { kind: "shapefile", files: parts, vfs: [], baseName: stem(shp.name), warnings };
  }
  if (files.length > 1) warnings.push(`Only the first file (${files[0].name}) is converted.`);
  const f = files[0];
  const ext = extOf(f.name);
  const byExt: Record<string, InputKind> = {
    geojson: "geojson", json: "geojson", kml: "kml", kmz: "kmz", csv: "csv", tsv: "csv", txt: "csv", gpx: "gpx", gpkg: "gpkg", zip: "shapefile-zip",
  };
  const kind = byExt[ext];
  if (!kind) throw new Error(`Unsupported file type ".${ext}". Use GeoJSON, KML/KMZ, Shapefile (.zip or parts), CSV, GPX or GeoPackage.`);
  const vfs = kind === "shapefile-zip" ? ["vsizip"] : kind === "kmz" ? ["vsizip"] : [];
  return { kind, files: [f], vfs, baseName: stem(f.name), warnings };
}

/** EPSG:xxxx, a bare number, or a PROJ/WKT string. Returns the string GDAL understands, or throws. */
export function parseSrs(input: string): string {
  const s = input.trim();
  if (!s) throw new Error("Empty coordinate system.");
  const m = /^(?:epsg:)?\s*(\d{4,6})$/i.exec(s);
  if (m) return `EPSG:${m[1]}`;
  if (/^\+proj=/.test(s) || /^(PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS)\[/i.test(s)) return s;
  if (/^(ESRI|IGNF):\w+$/i.test(s)) return s;
  throw new Error(`Not a coordinate system: "${s}". Use EPSG:4326, 32631, +proj=... or WKT.`);
}

export interface SrsPreset {
  code: string;
  label: string;
}

/** Common choices, with the Algerian ones first. */
export const SRS_PRESETS: readonly SrsPreset[] = [
  { code: "EPSG:4326", label: "WGS 84 (lon/lat)" },
  { code: "EPSG:3857", label: "Web Mercator" },
  { code: "EPSG:32629", label: "WGS 84 / UTM 29N" },
  { code: "EPSG:32630", label: "WGS 84 / UTM 30N" },
  { code: "EPSG:32631", label: "WGS 84 / UTM 31N" },
  { code: "EPSG:32632", label: "WGS 84 / UTM 32N" },
  { code: "EPSG:30729", label: "Nord Sahara 1959 / UTM 29N" },
  { code: "EPSG:30730", label: "Nord Sahara 1959 / UTM 30N" },
  { code: "EPSG:30731", label: "Nord Sahara 1959 / UTM 31N" },
  { code: "EPSG:30732", label: "Nord Sahara 1959 / UTM 32N" },
  { code: "EPSG:30791", label: "Nord Sahara 1959 / Nord Algérie" },
  { code: "EPSG:30792", label: "Nord Sahara 1959 / Sud Algérie" },
];

const LON = ["lon", "lng", "long", "longitude", "x", "xcoord", "easting"];
const LAT = ["lat", "latitude", "y", "ycoord", "northing"];
const WKT = ["wkt", "geom", "geometry", "the_geom", "wkt_geom"];

export function splitCsvHeader(line: string): string[] {
  const delim = [",", ";", "\t", "|"].reduce((best, d) => (line.split(d).length > line.split(best).length ? d : best), ",");
  return line.split(delim).map((h) => h.trim().replace(/^"|"$/g, ""));
}

/** Open options for GDAL's CSV driver, from the header row. */
export function csvOpenOptions(headerLine: string): { options: string[]; geometry: "xy" | "wkt" | "none" } {
  const cols = splitCsvHeader(headerLine.replace(/^﻿/, ""));
  const lower = cols.map((c) => c.toLowerCase());
  const wkt = cols[lower.findIndex((c) => WKT.includes(c))];
  if (wkt) return { options: [`GEOM_POSSIBLE_NAMES=${wkt}`, "KEEP_GEOM_COLUMNS=NO"], geometry: "wkt" };
  const x = cols[lower.findIndex((c) => LON.includes(c))];
  const y = cols[lower.findIndex((c) => LAT.includes(c))];
  if (x && y) return { options: [`X_POSSIBLE_NAMES=${x}`, `Y_POSSIBLE_NAMES=${y}`, "KEEP_GEOM_COLUMNS=NO"], geometry: "xy" };
  return { options: [], geometry: "none" };
}

export interface ConvertOptions {
  format: FormatId;
  targetSrs?: string; // empty = keep
  sourceSrs?: string; // empty = from the file
  /** Point CSVs are friendlier as X/Y columns; everything else uses WKT. */
  csvGeometry?: "wkt" | "xy";
  layerName?: string;
  /** For the preview: cap the number of features. */
  limit?: number;
  /** Source layers to convert (positional ogr2ogr arguments); empty = all. */
  layers?: string[];
}

/** Formats whose output holds exactly one layer. */
export const SINGLE_LAYER: readonly FormatId[] = ["geojson", "csv"];

/**
 * Which source layers to convert: skip empty ones (GPX always has five
 * layers, most of them empty) and keep only the first for single-layer formats.
 */
export function pickLayers(layers: { name: string; featureCount?: number }[], format: FormatId): { layers: string[]; dropped: string[] } {
  const nonEmpty = layers.filter((l) => (l.featureCount ?? 0) > 0).map((l) => l.name);
  const usable = nonEmpty.length ? nonEmpty : layers.slice(0, 1).map((l) => l.name);
  if (SINGLE_LAYER.includes(format) && usable.length > 1) return { layers: usable.slice(0, 1), dropped: usable.slice(1) };
  return { layers: usable, dropped: [] };
}

/** Arguments for Gdal.ogr2ogr. */
export function ogr2ogrArgs(o: ConvertOptions): string[] {
  const fmt = outputFormat(o.format);
  const args = ["-f", fmt.driver];
  const target = o.targetSrs ? parseSrs(o.targetSrs) : fmt.forcesWgs84 ? "EPSG:4326" : "";
  const source = o.sourceSrs ? parseSrs(o.sourceSrs) : "";
  // With a target, the source override is the "from" side of a reprojection;
  // without one, it just assigns the CRS to the output (ogr2ogr -a_srs).
  if (source && target) args.push("-s_srs", source, "-t_srs", target);
  else if (source) args.push("-a_srs", source);
  else if (target) args.push("-t_srs", target);
  if (o.format === "geojson") {
    // RFC 7946 GeoJSON is always WGS84; for another target CRS write classic GeoJSON with a "crs" member.
    const rfc = !target || target === "EPSG:4326";
    args.push("-lco", `RFC7946=${rfc ? "YES" : "NO"}`, "-lco", "WRITE_BBOX=YES");
  }
  if (o.format === "csv") {
    args.push("-lco", o.csvGeometry === "xy" ? "GEOMETRY=AS_XY" : "GEOMETRY=AS_WKT");
    args.push("-lco", "SEPARATOR=COMMA");
  }
  if (o.format === "shapefile") args.push("-lco", "ENCODING=UTF-8");
  if (o.format === "gpx") args.push("-dsco", "GPX_USE_EXTENSIONS=YES");
  if (o.format === "kml") args.push("-dsco", "NameField=name");
  if (o.layerName) args.push("-nln", o.layerName);
  if (o.limit && o.limit > 0) args.push("-limit", String(o.limit));
  if (o.layers?.length) args.push(...o.layers);
  return args;
}

/** "roads.shp" -> "roads-wgs84.kml" etc. */
export function outputName(baseName: string, format: FormatId, targetSrs?: string): string {
  const fmt = outputFormat(format);
  const clean = baseName.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "converted";
  const suffix = targetSrs ? "-" + parseSrs(targetSrs).replace(/^EPSG:/, "epsg").replace(/[^\w]+/g, "").slice(0, 20) : "";
  return `${clean}${suffix}.${fmt.multiFile ? "zip" : fmt.ext}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** EPSG code from a WKT string's last AUTHORITY/ID clause, if any. */
export function epsgFromWkt(wkt: string | undefined): string | null {
  if (!wkt) return null;
  const all = [...wkt.matchAll(/(?:AUTHORITY\["EPSG",\s*"(\d+)"\]|ID\["EPSG",\s*(\d+)\])/g)];
  const last = all[all.length - 1];
  return last ? `EPSG:${last[1] ?? last[2]}` : null;
}
