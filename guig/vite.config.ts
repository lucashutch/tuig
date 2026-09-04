import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist/frontend",
  },
  // Relative asset URLs so the bundle also loads from file:// in Electron.
  base: "./",
});
