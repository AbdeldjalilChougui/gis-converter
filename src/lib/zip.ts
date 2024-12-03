import { zipSync } from "fflate";

/** Zip several output files (e.g. .shp/.shx/.dbf/.prj/.cpg) into one archive. */
export function zipFiles(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.name.replace(/^.*[\\/]/, "")] = f.bytes;
  return zipSync(entries, { level: 6 });
}
