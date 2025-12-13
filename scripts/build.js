import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const srcDir = path.resolve(rootDir, "src");
const distDir = path.resolve(rootDir, "dist");

// Ensure dist directory exists
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}

const sharedConfig = {
  entryPoints: [path.resolve(srcDir, "index.ts")],
  bundle: true,
  sourcemap: true,
  target: ["es2020"],
};

const builds = [
  // ESM
  {
    ...sharedConfig,
    format: "esm",
    outfile: path.resolve(distDir, "hype.js"),
  },
  // ESM minified
  {
    ...sharedConfig,
    format: "esm",
    outfile: path.resolve(distDir, "hype.min.js"),
    minify: true,
  },
  // CommonJS
  {
    ...sharedConfig,
    format: "cjs",
    outfile: path.resolve(distDir, "hype.cjs"),
  },
  // CommonJS minified
  {
    ...sharedConfig,
    format: "cjs",
    outfile: path.resolve(distDir, "hype.min.cjs"),
    minify: true,
  },
  // IIFE for browsers
  {
    ...sharedConfig,
    format: "iife",
    globalName: "Hype",
    outfile: path.resolve(distDir, "hype.iife.js"),
  },
  // IIFE minified
  {
    ...sharedConfig,
    format: "iife",
    globalName: "Hype",
    outfile: path.resolve(distDir, "hype.iife.min.js"),
    minify: true,
  },

  // Loader: compile a lightweight client loader module and emit into the playground static path
  // This builds src/loader.ts -> playground/dev-server/public/static/js/loader.js
  {
    // override entryPoints to point to the loader source
    ...sharedConfig,
    entryPoints: [path.resolve(srcDir, "loader.ts")],
    format: "esm",
    outfile: path.resolve(rootDir, "playground", "dev-server", "public", "static", "js", "loader.js"),
  },
];

async function build() {
  const isWatch = process.argv.includes("--watch");

  if (isWatch) {
    console.log("Watching for changes...");
    const contexts = await Promise.all(builds.map((config) => esbuild.context(config)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
  } else {
    console.log("Building hype...");
    await Promise.all(builds.map((config) => esbuild.build(config)));

    // Generate TypeScript declarations
    const { execSync } = await import("child_process");
    execSync("npx tsc --emitDeclarationOnly --declaration --declarationDir dist", {
      cwd: rootDir,
      stdio: "inherit",
    });

    // Log bundle sizes
    const files = fs.readdirSync(distDir).filter((f) => f.endsWith(".js") || f.endsWith(".cjs"));
    console.log("\nBundle sizes:");
    for (const file of files) {
      const stats = fs.statSync(path.resolve(distDir, file));
      const size = (stats.size / 1024).toFixed(2);
      console.log(`  ${file}: ${size} KB`);
    }

    console.log("\nBuild complete!");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
