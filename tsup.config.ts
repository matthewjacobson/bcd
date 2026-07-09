import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    minify: false,
    target: "es2020",
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  // Browser global build for CDN <script> usage: window.bcd.decompose(...).
  {
    entry: ["src/index.ts"],
    format: ["iife"],
    globalName: "bcd",
    sourcemap: true,
    minify: true,
    target: "es2020",
    outExtension() {
      return { js: ".global.js" };
    },
  },
]);
