import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

const extension = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  outfile: "dist/extension.js",
  sourcemap: true,
};

const webview = {
  entryPoints: ["webview/main.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  outfile: "dist/webview.js",
  minify: true,
  legalComments: "none",
};

mkdirSync("dist", { recursive: true });
copyFileSync("webview/style.css", "dist/webview.css");

if (watch) {
  for (const cfg of [extension, webview]) {
    const ctx = await esbuild.context(cfg);
    await ctx.watch();
  }
  console.log("watching…");
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
  console.log("build complete");
}
