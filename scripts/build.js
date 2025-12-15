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

// For core (non-rx) builds we intentionally mark rxjs as external so the core
// artifacts do not accidentally include rxjs in their bundles. Rx-bundled
// builds use a dedicated entry that imports the rx-specific adapter directly.
const coreBuildOverrides = {
  // Exclude rxjs from core bundles
  external: ["rxjs"],
};

const builds = [
  // Core builds (no rx)
  // ESM
  {
    ...sharedConfig,
    ...coreBuildOverrides,
    format: "esm",
    outfile: path.resolve(distDir, "hype.js"),
  },
  // ESM minified
  {
    ...sharedConfig,
    ...coreBuildOverrides,
    format: "esm",
    outfile: path.resolve(distDir, "hype.min.js"),
    minify: true,
  },
  // CommonJS
  {
    ...sharedConfig,
    ...coreBuildOverrides,
    format: "cjs",
    outfile: path.resolve(distDir, "hype.cjs"),
  },
  // CommonJS minified
  {
    ...sharedConfig,
    ...coreBuildOverrides,
    format: "cjs",
    outfile: path.resolve(distDir, "hype.min.cjs"),
    minify: true,
  },
  // IIFE for browsers
  {
    ...sharedConfig,
    ...coreBuildOverrides,
    format: "iife",
    globalName: "Hype",
    outfile: path.resolve(distDir, "hype.iife.js"),
  },
  // IIFE minified
  {
    ...sharedConfig,
    ...coreBuildOverrides,
    format: "iife",
    globalName: "Hype",
    outfile: path.resolve(distDir, "hype.iife.min.js"),
    minify: true,
  },

  // Rx-bundled builds
  // NOTE: these entries use a dedicated entry that should import the Rx adapter/wrapper
  // (e.g. src/services/rx-event-system.bundle.ts). That file is intentionally separate so the
  // core runtime remains free of an rxjs dependency unless you choose the rx bundle.
  //
  // ESM (rx)
  {
    ...sharedConfig,
    entryPoints: [path.resolve(srcDir, "hype-rx.ts")],
    format: "esm",
    outfile: path.resolve(distDir, "hype-rx.js"),
  },
  // ESM minified (rx)
  {
    ...sharedConfig,
    entryPoints: [path.resolve(srcDir, "hype-rx.ts")],
    format: "esm",
    outfile: path.resolve(distDir, "hype-rx.min.js"),
    minify: true,
  },
  // CommonJS (rx)
  {
    ...sharedConfig,
    entryPoints: [path.resolve(srcDir, "hype-rx.ts")],
    format: "cjs",
    outfile: path.resolve(distDir, "hype-rx.cjs"),
  },
  // CommonJS minified (rx)
  {
    ...sharedConfig,
    entryPoints: [path.resolve(srcDir, "hype-rx.ts")],
    format: "cjs",
    outfile: path.resolve(distDir, "hype-rx.min.cjs"),
    minify: true,
  },
  // IIFE for browsers (rx)
  {
    ...sharedConfig,
    entryPoints: [path.resolve(srcDir, "hype-rx.ts")],
    format: "iife",
    globalName: "HypeRx",
    outfile: path.resolve(distDir, "hype-rx.iife.js"),
  },
  // IIFE minified (rx)
  {
    ...sharedConfig,
    entryPoints: [path.resolve(srcDir, "hype-rx.ts")],
    format: "iife",
    globalName: "HypeRx",
    outfile: path.resolve(distDir, "hype-rx.iife.min.js"),
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

    // Allow selective builds:
    // - `--core` builds core artifacts (excludes `hype-rx.*`) and still emits the loader
    // - `--rx` builds rx-bundled artifacts (includes `hype-rx.*`) and still emits the loader
    // - no flag builds everything (default)
    const onlyCore = process.argv.includes("--core");
    const onlyRx = process.argv.includes("--rx");

    const selectedBuilds = builds.filter((cfg) => {
      const out = String(cfg.outfile || "");
      const isRx = out.includes("hype-rx");
      const isLoader = out.endsWith("loader.js") || out.includes(path.join("public", "static", "js", "loader.js"));
      if (onlyCore) {
        // include loader by allowing non-rx builds and the loader
        return !isRx || isLoader;
      }
      if (onlyRx) {
        // include rx builds and the loader
        return isRx || isLoader;
      }
      return true;
    });

    if (selectedBuilds.length === 0) {
      console.log("No builds selected (check --core / --rx flags).");
    } else {
      await Promise.all(selectedBuilds.map((config) => esbuild.build(config)));
    }

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
