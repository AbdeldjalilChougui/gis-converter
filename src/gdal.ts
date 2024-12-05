// Thin wrapper around gdal3.js (GDAL compiled to WebAssembly, running in a Web Worker).
import initGdalJs from "gdal3.js";
import { csvOpenOptions, epsgFromWkt, ogr2ogrArgs, outputFormat, pickLayers, type ConvertOptions, type InputPlan } from "./lib/formats";
import { zipFiles } from "./lib/zip";

type Gdal = Awaited<ReturnType<typeof initGdalJs>>;
type Dataset = Awaited<ReturnType<Gdal["open"]>>["datasets"][number];
export type DatasetInfo = Awaited<ReturnType<Gdal["getInfo"]>>;

let gdal: Promise<Gdal> | null = null;

/** Loads the ~40 MB runtime once (cached by the browser afterwards). */
export function loadGdal(): Promise<Gdal> {
  if (!gdal) {
    // public/gdal is served under the Vite base (e.g. /gis-converter/gdal on GitHub Pages).
    const path = new URL(`${import.meta.env.BASE_URL}gdal`, location.href).href;
    gdal = initGdalJs({ path, useWorker: true });
  }
  return gdal;
}

export interface Opened {
  dataset: Dataset;
  info: DatasetInfo;
  csvGeometry: "xy" | "wkt" | "none" | null;
  /** Used when the file carries no CRS and the user gave none (CSV coordinates are assumed WGS84). */
  defaultSourceSrs?: string;
  /** CRS of the first layer as reported by ogrinfo ("EPSG:xxxx", "custom" or null). */
  srs: string | null;
}

async function layerSrs(g: Gdal, dataset: Dataset): Promise<string | null> {
  try {
    const info = (await g.ogrinfo(dataset, ["-json", "-so"])) as {
      layers?: { geometryFields?: { coordinateSystem?: { wkt?: string; projjson?: { id?: { authority: string; code: number } } } }[] }[];
    };
    for (const l of info.layers ?? []) {
      const cs = l.geometryFields?.[0]?.coordinateSystem;
      if (!cs) continue;
      const id = cs.projjson?.id;
      if (id) return `${id.authority}:${id.code}`;
      return epsgFromWkt(cs.wkt) ?? (cs.wkt ? "custom" : null);
    }
  } catch {
    /* older GDAL without ogrinfo -json */
  }
  return null;
}

export async function openInput(plan: InputPlan, files: File[]): Promise<Opened> {
  const g = await loadGdal();
  const chosen = files.filter((f) => plan.files.some((p) => p.name === f.name));
  let options: string[] = [];
  let csvGeometry: Opened["csvGeometry"] = null;
  if (plan.kind === "csv") {
    const head = (await chosen[0].slice(0, 4096).text()).split(/\r?\n/)[0];
    const csv = csvOpenOptions(head);
    options = csv.options;
    csvGeometry = csv.geometry;
  }
  if (plan.kind === "shapefile") options = ["SHAPE_RESTORE_SHX=YES"];
  const input = plan.kind === "shapefile" ? chosen : chosen[0];
  const res = await g.open(input as never, options, plan.vfs);
  const dataset = res.datasets.find((d) => d.type === "vector") ?? res.datasets[0];
  if (!dataset) throw new Error(res.errors.join("\n") || "GDAL could not open this file.");
  const info = await g.getInfo(dataset);
  const srs = (await layerSrs(g, dataset)) ?? epsgFromWkt(info.projectionWkt);
  return { dataset, info, csvGeometry, srs, defaultSourceSrs: plan.kind === "csv" && !srs ? "EPSG:4326" : undefined };
}

export interface Output {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export async function convert(opened: Opened, opts: ConvertOptions, fileName: string): Promise<Output> {
  const g = await loadGdal();
  const fmt = outputFormat(opts.format);
  const stemName = fileName.replace(/\.[^.]+$/, "");
  const { layers } = pickLayers(opened.info.layers ?? [], opts.format);
  const effective = { ...opts, sourceSrs: opts.sourceSrs || opened.defaultSourceSrs, layers };
  let out;
  try {
    out = await g.ogr2ogr(opened.dataset, ogr2ogrArgs(effective), stemName);
  } catch (e) {
    throw new Error(explain(e));
  }
  if (fmt.multiFile) {
    const all = (await g.getOutputFiles()).filter((f) => f.path.replace(/^.*\//, "").startsWith(stemName + "."));
    const parts = await Promise.all(all.map(async (f) => ({ name: f.path, bytes: await g.getFileBytes(f.path) })));
    return { name: fileName, bytes: zipFiles(parts), mime: fmt.mime };
  }
  return { name: fileName, bytes: await g.getFileBytes(out), mime: fmt.mime };
}

function explain(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  if (/hDS|NULL/.test(msg)) {
    return "GDAL could not write the output. If the input has no coordinate system, set the source CRS (or leave the target CRS empty).";
  }
  return msg;
}

/** GeoJSON in WGS84 for the map preview (capped to keep the page responsive). */
export async function previewGeoJSON(opened: Opened, sourceSrs: string | undefined, limit = 20000): Promise<GeoJSON.FeatureCollection> {
  const out = await convert(opened, { format: "geojson", targetSrs: "EPSG:4326", sourceSrs, limit }, `preview-${Date.now()}.geojson`);
  return JSON.parse(new TextDecoder().decode(out.bytes));
}
