const fs = require("fs");
const path = require("path");
const { applyRateLimitsToSpec } = require("./rate-limits");

function mergeSpec(basePath, enrichmentPath) {
  const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
  const enrich = JSON.parse(fs.readFileSync(enrichmentPath, "utf8"));

  const spec = { ...base };
  if (enrich.info) spec.info = { ...base.info, ...enrich.info };
  if (enrich.components) {
    spec.components = { ...(base.components || {}), ...enrich.components };
  }
  if (enrich.security) spec.security = enrich.security;

  const portal = { ...(enrich["x-portal"] || {}) };

  for (const [pathKey, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!op.operationId) continue;
      const patch = enrich.operations?.[op.operationId];
      if (!patch) continue;
      Object.assign(op, patch);
      if (patch.security !== undefined) op.security = patch.security;
    }
  }

  if (!spec.paths["/info"] && spec.paths["/api/v1/info"]) {
    spec.paths["/info"] = spec.paths["/api/v1/info"];
    delete spec.paths["/api/v1/info"];
  }

  for (const [pathKey, methods] of Object.entries(spec.paths || {})) {
    for (const op of Object.values(methods)) {
      if (op.operationId === "Login" || op.operationId === "getApiInfo") continue;
      if (!op.security && pathKey !== "/login") {
        op.security = [{ ApiKeyPublic: [] }, { ApiKeyPrivate: [] }];
      }
    }
  }

  applyRateLimitsToSpec(spec);
  spec["x-portal"] = {
    ...portal,
    ...spec["x-portal"],
    rateLimitHeaders: portal.rateLimitHeaders || spec["x-portal"].rateLimitHeaders,
    errorCodes: portal.errorCodes || spec["x-portal"].errorCodes,
    workflows: portal.workflows || spec["x-portal"].workflows,
    glossary: portal.glossary || spec["x-portal"].glossary,
  };

  return spec;
}

function loadMergedSpec(rootDir) {
  return mergeSpec(
    path.join(rootDir, "shipmozo-openapi.json"),
    path.join(rootDir, "shipmozo-enrichment.json")
  );
}

module.exports = { mergeSpec, loadMergedSpec };
