import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // `vite build --mode demo` (bun run build:demo) builds the read-only public
  // demo in src/demo/: no server, recorded fixtures only. Every other mode
  // compiles that code out, so the product build is unchanged.
  define: {
    __STATIC_DEMO__: JSON.stringify(mode === "demo"),
  },
  build: {
    outDir: "dist",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:4500",
        changeOrigin: false,
      },
    },
  },
}));
