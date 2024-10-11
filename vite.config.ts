import { defineConfig } from "vite";

export default defineConfig({
  // Served from GitHub Pages at https://abdeldjalilchougui.github.io/gis-converter/
  base: "/gis-converter/",
  build: { chunkSizeWarningLimit: 1500 },
  test: { include: ["test/**/*.test.ts"] },
} as never);
