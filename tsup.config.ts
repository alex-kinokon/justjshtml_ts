import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "lib",
  // fixedExtension: false,
  // dts: { tsgo: true },
  dts: true,
  format: "esm",
  clean: true,
  banner: { js: "/* eslint-disable */" },
  footer: { js: "/* eslint-enable */" },
});
