import { defineConfig } from "vite";

// Builds the browser viewer in website/ (deployed to bpub.bitfiles.io).
// The page imports the library straight from src/, so no `npm run build`
// is needed first.
export default defineConfig({
  root: "website",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
