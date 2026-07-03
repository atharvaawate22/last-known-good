const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Prints in the format the "esbuild Problem Matchers" VS Code extension
// (connor4312.esbuild-problem-matchers, recommended in .vscode/extensions.json)
// expects: "[watch] build started"/"finished" markers for the background
// matcher, plus one "file:line:col: error: message" line per diagnostic.
/** @type {import("esbuild").Plugin} */
const problemMatcherPlugin = {
  name: "problem-matcher",
  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      for (const { text, location } of [...result.errors, ...result.warnings]) {
        const where = location ? `${location.file}:${location.line}:${location.column}` : "?";
        console.error(`${where}: error: ${text}`);
      }
      console.log("[watch] build finished");
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [problemMatcherPlugin],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
