// Mark a built output directory as an ES module scope.
//
// The packaged desktop ships these trees in Resources/, outside app.asar, so
// the app's own package.json ("type": "module") does not cover them. Without
// a package.json of their own, Node takes the format of their .js files from
// the nearest package.json above the install folder, and a stray `npm init -y`
// in the user's home (npm 11 writes "type": "commonjs") turns every `import`
// into a SyntaxError at startup (issue #2770). bundle-server.mjs does the same
// for dist-server.
//
//   node scripts/mark-module-scope.mjs dist-companion
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: node scripts/mark-module-scope.mjs <dir>...");
  process.exit(1);
}
for (const dir of dirs) writeFileSync(join(resolve(dir), "package.json"), '{"type":"module"}\n');
