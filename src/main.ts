import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { convert, openInput, previewGeoJSON, type Opened } from "./gdal";
import { formatBytes, OUTPUT_FORMATS, outputFormat, outputName, parseSrs, planInput, SRS_PRESETS, type FormatId, type InputPlan } from "./lib/formats";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (msg: string, cls = "muted") => {
  const s = $("status");
  s.className = cls;
  s.textContent = msg;
};

for (const f of OUTPUT_FORMATS) $("format").append(new Option(f.label, f.id));
for (const p of SRS_PRESETS) $("srs").append(Object.assign(document.createElement("option"), { value: p.code, label: p.label }));

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  },
  center: [3, 30],
  zoom: 3,
});
map.on("load", () => {
  map.addSource("data", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "fill", type: "fill", source: "data", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#0f766e", "fill-opacity": 0.25 } });
  map.addLayer({ id: "line", type: "line", source: "data", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": "#0f766e", "line-width": 1.5 } });
  map.addLayer({ id: "pt", type: "circle", source: "data", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-color": "#0f766e", "circle-radius": 4, "circle-stroke-color": "#fff", "circle-stroke-width": 1 } });
  for (const l of ["fill", "line", "pt"]) {
    map.on("click", l, (e) => {
      const p = e.features?.[0]?.properties ?? {};
      const rows = Object.entries(p).slice(0, 20).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join("");
      new maplibregl.Popup({ maxWidth: "320px" }).setLngLat(e.lngLat).setHTML(`<table>${rows}</table>`).addTo(map);
    });
  }
});

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

let opened: Opened | null = null;
let plan: InputPlan | null = null;
let files: File[] = [];

function bboxOf(fc: GeoJSON.FeatureCollection): [number, number, number, number] | null {
  let b: [number, number, number, number] | null = null;
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === "number") {
      const [x, y] = c as number[];
      b = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y];
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  for (const f of fc.features) if (f.geometry && "coordinates" in f.geometry) visit(f.geometry.coordinates);
  return b;
}

async function refreshPreview() {
  if (!opened) return;
  const src = $<HTMLInputElement>("source").value.trim() || undefined;
  const fc = await previewGeoJSON(opened, src);
  (map.getSource("data") as maplibregl.GeoJSONSource).setData(fc);
  const b = bboxOf(fc);
  if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 40, maxZoom: 16, duration: 0 });
  return fc.features.length;
}

async function load(selected: File[]) {
  files = selected;
  opened = null;
  $<HTMLFieldSetElement>("opts").disabled = true;
  $("info").innerHTML = "";
  try {
    plan = planInput(selected.map((f) => ({ name: f.name, size: f.size })));
    status("Loading GDAL (first time only, ~40 MB)…");
    opened = await openInput(plan, selected);
    const info = opened.info;
    const epsg = opened.srs;
    const layers = (info.layers ?? []).map((l) => `${esc(l.name)} (${l.featureCount})`).join("<br>");
    const total = (info.layers ?? []).reduce((n, l) => n + (l.featureCount ?? 0), 0);
    const warn = plan.warnings.map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join("");
    const csvNote = opened.csvGeometry === "none" ? `<p class="warn">⚠ No lon/lat or WKT column found: rows have no geometry.</p>` : "";
    $("info").innerHTML = `<table>
      <tr><td>Input</td><td>${esc(plan.files.map((f) => f.name).join(", "))} · ${formatBytes(selected.reduce((n, f) => n + f.size, 0))}</td></tr>
      <tr><td>Driver</td><td>${esc(info.driverName ?? "?")}</td></tr>
      <tr><td>Layers</td><td>${layers || "–"}</td></tr>
      <tr><td>CRS</td><td>${esc(epsg ?? (opened.defaultSourceSrs ? `none (assuming ${opened.defaultSourceSrs})` : "unknown, set the source CRS"))}</td></tr></table>${warn}${csvNote}`;
    $<HTMLFieldSetElement>("opts").disabled = false;
    $("csvxy").hidden = $<HTMLSelectElement>("format").value !== "csv";
    const shown = await refreshPreview();
    status(`Ready. Previewing ${shown} of ${total} features.`);
  } catch (e) {
    status((e as Error).message, "error");
  }
}

$<HTMLInputElement>("file").onchange = (e) => {
  const list = (e.target as HTMLInputElement).files;
  if (list?.length) load([...list]);
};
const drop = $("drop");
drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer?.files.length) load([...e.dataTransfer.files]);
});
$("format").onchange = () => {
  $("csvxy").hidden = $<HTMLSelectElement>("format").value !== "csv";
};
$("source").onchange = async () => {
  try {
    const v = $<HTMLInputElement>("source").value.trim();
    if (v) parseSrs(v);
    await refreshPreview();
    status("Preview updated with the source CRS override.");
  } catch (e) {
    status((e as Error).message, "error");
  }
};

$("convert").onclick = async () => {
  if (!opened || !plan) return;
  const format = $<HTMLSelectElement>("format").value as FormatId;
  const target = $<HTMLInputElement>("target").value.trim();
  const source = $<HTMLInputElement>("source").value.trim();
  try {
    const name = outputName(plan.baseName, format, target || undefined);
    status(`Converting to ${outputFormat(format).label}…`);
    const t0 = performance.now();
    const out = await convert(opened, { format, targetSrs: target || undefined, sourceSrs: source || undefined, csvGeometry: $<HTMLInputElement>("xy").checked ? "xy" : "wkt" }, name);
    const url = URL.createObjectURL(new Blob([out.bytes as BlobPart], { type: out.mime }));
    const a = Object.assign(document.createElement("a"), { href: url, download: out.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    status(`Done: ${out.name} (${formatBytes(out.bytes.length)}) in ${Math.round(performance.now() - t0)} ms.`);
    (window as unknown as { __lastOutput?: unknown }).__lastOutput = { name: out.name, size: out.bytes.length, head: new TextDecoder().decode(out.bytes.slice(0, 120)) };
  } catch (e) {
    status((e as Error).message, "error");
  }
};
