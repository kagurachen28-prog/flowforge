const fs = require("fs");
const path = require("path");
const pkgPath = path.join(__dirname, "..", "package.json");
const distPath = path.join(__dirname, "..", "dist/flowforge.js");
const version = require(pkgPath).version;
const dist = fs.readFileSync(distPath, "utf8");
const patched = dist.replace(
  /process\.env\.npm_package_version \?\? "[^"]+"/g,
  `process.env.npm_package_version ?? "${version}"`
);
fs.writeFileSync(distPath, patched);
console.log(`dist version: ${version}`);
