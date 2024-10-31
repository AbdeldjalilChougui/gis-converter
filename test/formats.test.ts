import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  pickLayers, csvOpenOptions, epsgFromWkt, extOf, formatBytes, ogr2ogrArgs, OUTPUT_FORMATS, outputName, parseSrs, planInput, SRS_PRESETS, stem,
} from "../src/lib/formats";
import { zipFiles } from "../src/lib/zip";

const f = (...names: string[]) => names.map((name) => ({ name }));

describe("planInput", () => {
  it("recognises single-file formats", () => {
    expect(planInput(f("a.geojson")).kind).toBe("geojson");
    expect(planInput(f("A.JSON")).kind).toBe("geojson");
    expect(planInput(f("tracks.gpx")).kind).toBe("gpx");
    expect(planInput(f("db.gpkg")).kind).toBe("gpkg");
    expect(planInput(f("pts.csv")).kind).toBe("csv");
    const kmz = planInput(f("doc.kmz"));
    expect(kmz.vfs).toEqual(["vsizip"]);
  });
  it("opens zipped shapefiles through /vsizip/", () => {
    const p = planInput(f("communes.zip"));
    expect(p).toMatchObject({ kind: "shapefile-zip", vfs: ["vsizip"], baseName: "communes" });
  });
  it("groups loose shapefile parts and warns about missing ones", () => {
    const p = planInput(f("roads.SHP", "roads.dbf", "roads.shx", "roads.prj", "other.dbf", "notes.txt"));
    expect(p.kind).toBe("shapefile");
    expect(p.files.map((x) => x.name).sort()).toEqual(["roads.SHP", "roads.dbf", "roads.prj", "roads.shx"]);
    expect(p.warnings).toEqual([]);
    const q = planInput(f("roads.shp", "roads.dbf"));
    expect(q.warnings.join(" ")).toMatch(/shx/);
    expect(q.warnings.join(" ")).toMatch(/prj/);
    expect(() => planInput(f("roads.shp", "roads.shx"))).toThrow(/\.dbf/);
  });
  it("rejects unknown types and empty selections", () => {
    expect(() => planInput([])).toThrow();
    expect(() => planInput(f("image.tif"))).toThrow(/Unsupported/);
    expect(planInput(f("a.kml", "b.kml")).warnings[0]).toMatch(/first file/);
  });
});

describe("SRS parsing", () => {
  it("accepts EPSG codes in several spellings", () => {
    expect(parseSrs("4326")).toBe("EPSG:4326");
    expect(parseSrs(" epsg:32631 ")).toBe("EPSG:32631");
    expect(parseSrs("EPSG:30791")).toBe("EPSG:30791");
    expect(parseSrs("+proj=utm +zone=31 +ellps=clrk80")).toMatch(/^\+proj/);
    expect(parseSrs('GEOGCS["WGS 84",DATUM["x"]]')).toMatch(/^GEOGCS/);
    expect(parseSrs("ESRI:102100")).toBe("ESRI:102100");
  });
  it("rejects garbage", () => {
    expect(() => parseSrs("")).toThrow();
    expect(() => parseSrs("WGS84 please")).toThrow();
    expect(() => parseSrs("12")).toThrow();
  });
  it("finds the EPSG code in WKT1 and WKT2", () => {
    expect(epsgFromWkt('PROJCS["x",GEOGCS["y",AUTHORITY["EPSG","4307"]],AUTHORITY["EPSG","30731"]]')).toBe("EPSG:30731");
    expect(epsgFromWkt('GEOGCRS["WGS 84",ID["EPSG",4326]]')).toBe("EPSG:4326");
    expect(epsgFromWkt("LOCAL_CS[]")).toBeNull();
    expect(epsgFromWkt(undefined)).toBeNull();
  });
  it("presets are valid", () => {
    for (const p of SRS_PRESETS) expect(parseSrs(p.code)).toBe(p.code);
  });
});

describe("CSV detection", () => {
  it("finds lon/lat columns with any delimiter", () => {
    expect(csvOpenOptions("id,name,Longitude,Latitude")).toEqual({
      options: ["X_POSSIBLE_NAMES=Longitude", "Y_POSSIBLE_NAMES=Latitude", "KEEP_GEOM_COLUMNS=NO"], geometry: "xy",
    });
    expect(csvOpenOptions("﻿nom;lat;lon").options[0]).toBe("X_POSSIBLE_NAMES=lon");
    expect(csvOpenOptions("a\tx\ty").geometry).toBe("xy");
  });
  it("prefers a WKT column and reports none otherwise", () => {
    expect(csvOpenOptions('"id","WKT","lat","lon"').options[0]).toBe("GEOM_POSSIBLE_NAMES=WKT");
    expect(csvOpenOptions("a,b,c").geometry).toBe("none");
  });
});

describe("ogr2ogr arguments", () => {
  it("builds per-format options", () => {
    expect(ogr2ogrArgs({ format: "geojson" })).toEqual(["-f", "GeoJSON", "-lco", "RFC7946=YES", "-lco", "WRITE_BBOX=YES"]);
    expect(ogr2ogrArgs({ format: "shapefile", targetSrs: "32631" })).toEqual(["-f", "ESRI Shapefile", "-t_srs", "EPSG:32631", "-lco", "ENCODING=UTF-8"]);
    expect(ogr2ogrArgs({ format: "csv", csvGeometry: "xy" })).toContain("GEOMETRY=AS_XY");
    expect(ogr2ogrArgs({ format: "csv" })).toContain("GEOMETRY=AS_WKT");
  });
  it("forces WGS84 for KML and GPX unless told otherwise", () => {
    const kml = ogr2ogrArgs({ format: "kml" });
    expect(kml.slice(kml.indexOf("-t_srs"), kml.indexOf("-t_srs") + 2)).toEqual(["-t_srs", "EPSG:4326"]);
    expect(ogr2ogrArgs({ format: "gpx" })).toContain("GPX_USE_EXTENSIONS=YES");
  });
  it("assigns a source CRS when there is no target", () => {
    expect(ogr2ogrArgs({ format: "csv", sourceSrs: "4326" }).slice(0, 4)).toEqual(["-f", "CSV", "-a_srs", "EPSG:4326"]);
    const gpx = ogr2ogrArgs({ format: "gpx", sourceSrs: "4326" });
    expect(gpx.slice(2, 6)).toEqual(["-s_srs", "EPSG:4326", "-t_srs", "EPSG:4326"]);
  });
  it("writes RFC 7946 GeoJSON only for WGS84", () => {
    expect(ogr2ogrArgs({ format: "geojson", targetSrs: "4326" })).toContain("RFC7946=YES");
    expect(ogr2ogrArgs({ format: "geojson", targetSrs: "3857" })).toContain("RFC7946=NO");
  });
  it("adds source SRS override, layer name and limit", () => {
    const a = ogr2ogrArgs({ format: "gpkg", sourceSrs: "30731", targetSrs: "4326", layerName: "wells", limit: 100 });
    expect(a).toEqual(["-f", "GPKG", "-s_srs", "EPSG:30731", "-t_srs", "EPSG:4326", "-nln", "wells", "-limit", "100"]);
    expect(() => ogr2ogrArgs({ format: "geojson", targetSrs: "nope" })).toThrow();
  });
});

describe("names and sizes", () => {
  it("builds output file names", () => {
    expect(outputName("roads", "kml")).toBe("roads.kml");
    expect(outputName("my roads", "shapefile", "EPSG:32631")).toBe("my_roads-epsg32631.zip");
    expect(outputName("", "geojson")).toBe("converted.geojson");
    expect(outputName("a", "csv", "+proj=longlat")).toMatch(/^a-projlonglat\.csv$/);
  });
  it("helpers", () => {
    expect(extOf("A.B.GeoJSON")).toBe("geojson");
    expect(extOf("noext")).toBe("");
    expect(stem("dir/x.tar.gz")).toBe("x.tar");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(30 * 1024 * 1024)).toBe("30 MB");
    expect(OUTPUT_FORMATS.map((x) => x.id)).toEqual(["geojson", "kml", "shapefile", "csv", "gpx", "gpkg"]);
  });
  it("zips multi-file outputs", () => {
    const z = zipFiles([{ name: "/out/a.shp", bytes: new Uint8Array([1, 2]) }, { name: "a.dbf", bytes: new Uint8Array([3]) }]);
    const back = unzipSync(z);
    expect(Object.keys(back).sort()).toEqual(["a.dbf", "a.shp"]);
    expect([...back["a.shp"]]).toEqual([1, 2]);
  });
});

describe("layer selection", () => {
  const gpx = [
    { name: "waypoints", featureCount: 4 }, { name: "routes", featureCount: 0 }, { name: "tracks", featureCount: 2 },
    { name: "route_points", featureCount: 0 }, { name: "track_points", featureCount: 0 },
  ];
  it("skips empty layers and keeps one for single-layer formats", () => {
    expect(pickLayers(gpx, "kml")).toEqual({ layers: ["waypoints", "tracks"], dropped: [] });
    expect(pickLayers(gpx, "geojson")).toEqual({ layers: ["waypoints"], dropped: ["tracks"] });
    expect(pickLayers([{ name: "empty", featureCount: 0 }], "geojson").layers).toEqual(["empty"]);
    expect(ogr2ogrArgs({ format: "kml", layers: ["a", "b"] }).slice(-2)).toEqual(["a", "b"]);
  });
});
