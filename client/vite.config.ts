import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5173,
    fs: {
      allow: [resolve(__dirname, "..")]
    }
  },
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "../shared")
    }
  }
});
