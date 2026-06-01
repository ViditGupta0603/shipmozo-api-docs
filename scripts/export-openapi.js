const fs = require("fs");
const path = require("path");
const { loadMergedSpec } = require("../lib/merge-spec");

const root = path.join(__dirname, "..");
const spec = loadMergedSpec(root);
const json = JSON.stringify(spec, null, 2);

const outputs = [
  path.join(root, "spec", "openapi.json"),
  path.join(root, "public", "assets", "spec.json"),
];

for (const out of outputs) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json);
  console.log("Exported", out, "—", Object.keys(spec.paths).length, "paths");
}
