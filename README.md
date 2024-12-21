# gis-converter

An in-browser GIS file converter: **Shapefile (zip or loose parts), KML/KMZ,
GeoJSON, CSV, GPX and GeoPackage**, with reprojection and a map preview.
It runs [GDAL](https://gdal.org) compiled to WebAssembly
([gdal3.js](https://github.com/bugra9/gdal3.js)) in a Web Worker.
**Files never leave your machine.** There is no server-side code at all, and
the built site is static files.

**Live demo: <https://abdeldjalilchougui.github.io/gis-converter/>** (static site on GitHub Pages; your files stay in the browser).

## Install

Nothing to install: open the [live demo](https://abdeldjalilchougui.github.io/gis-converter/). To run it locally or host
your own copy:

```sh
git clone https://github.com/AbdeldjalilChougui/gis-converter.git
cd gis-converter
pnpm install
pnpm dev
```

The production build uses the Vite base `/gis-converter/` (see `vite.config.ts`);
change it if you serve the site from another path.

## Quick start

```sh
pnpm install
pnpm dev        # copies the GDAL runtime into public/gdal, then http://localhost:5173/gis-converter/
pnpm test       # vitest (pure helpers)
pnpm build      # static site in dist/ (~40 MB, mostly the GDAL WASM + data)
```

1. Drop a file (or several shapefile parts) on the drop zone. The panel shows the driver, layers with feature
   counts and the detected CRS, and the map previews the data in WGS84.
2. Pick an output format and, optionally, a **target CRS**. Presets include WGS 84, Web Mercator, WGS 84 UTM
   29–32N and Nord Sahara 1959 (UTM 29–32N, Nord/Sud Algérie). Any `EPSG:` code, PROJ string or WKT also works.
3. If the file has no CRS (a shapefile without `.prj`), set the **source CRS override**. The preview updates
   immediately.
4. **Convert & download.** Shapefile output is zipped (`.shp/.shx/.dbf/.prj/.cpg`).

## How it works

```
src/lib/formats.ts  pure helpers (unit tested): input detection, output format registry,
                    ogr2ogr argument builder, CRS parsing, CSV column sniffing, layer picking, names
src/lib/zip.ts      zips multi-file outputs (fflate)
src/gdal.ts         gdal3.js wrapper: open (with /vsizip/ for .zip and .kmz), CRS via `ogrinfo -json`,
                    ogr2ogr, read output bytes
src/main.ts         UI + MapLibre preview
scripts/copy-gdal.mjs  copies gdal3.js' worker, .wasm and .data into public/gdal
```

- **Input detection.** The extension decides the driver. Loose shapefile parts are grouped by name, with an
  error if `.dbf` is missing and a warning if `.shx` or `.prj` is. CSV headers are sniffed for `lon/lng/x` +
  `lat/y` or a `WKT/geometry` column and passed as CSV open options. Coordinates of a CSV without a CRS are
  assumed to be WGS84.
- **ogr2ogr arguments per format:**
  - GeoJSON is RFC 7946 when the target is WGS84 and classic GeoJSON with a `crs` member otherwise
  - KML and GPX are always reprojected to WGS84
  - CSV writes WKT, or X/Y columns on request
  - Shapefile is written as UTF-8
  - A source override becomes `-s_srs` when there is a target and `-a_srs` when there is none
- **Layers.** Empty layers are skipped (GPX always exposes five). Single-layer formats (GeoJSON, CSV) take the
  first non-empty layer.
- **Preview.** A second ogr2ogr run to WGS84 GeoJSON, capped at 20,000 features.

## Tests

`pnpm test` runs 19 tests on the pure helpers:
- input planning (single files, zips, KMZ, loose shapefile parts with missing pieces, unsupported types)
- CRS parsing (EPSG spellings, PROJ, WKT, ESRI codes, garbage) and EPSG extraction from WKT1/WKT2
- CSV column detection with `,` `;` and tab and a BOM
- ogr2ogr arguments for every format, including `-s_srs` vs `-a_srs`, RFC 7946 switching, layer name, limit and
  positional layers
- output names, byte formatting, zip round trip, and layer picking for GPX

The GDAL integration was checked by hand in headless Chrome against the production build:
- CSV → Shapefile (EPSG:32631), KML, GeoPackage (EPSG:30731), CSV, GPX and GeoJSON
- zipped Shapefile in EPSG:30731 → GeoJSON, CSV and Shapefile
- GPX → GeoJSON, CSV and Shapefile

These browser checks are not automated in CI.

## Status and limitations

- The first load downloads about 40 MB (cached afterwards). Large files are limited by browser memory.
- Only the first file is used unless the files are shapefile parts. Multi-layer GeoPackage/KML inputs convert
  all non-empty layers to multi-layer outputs, but GeoJSON/CSV get only the first one.
- No raster formats, no attribute filtering or field mapping (yet).
- The KML `NameField` is `name`. Other attributes go to `ExtendedData`.
- The preview basemap is tile.openstreetmap.org (light use).

## License

MIT, see [LICENSE](LICENSE). gdal3.js is LGPL-2.1 and GDAL is MIT/X. Both are
served unmodified from `node_modules`. Basemap © OpenStreetMap contributors.
The sample CSV holds approximate city coordinates typed by hand.
