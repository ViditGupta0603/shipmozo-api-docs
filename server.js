const express = require("express");
const path = require("path");
const { loadMergedSpec } = require("./lib/merge-spec");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const publicDir = path.join(__dirname, "public");
const PRODUCTION_BASE = "https://appiify.com/app/api/v1";

const swaggerDocument = loadMergedSpec(__dirname);

app.use(express.json({ limit: "4mb" }));

/** API routes — always before static files */
app.get("/api/spec.json", (_req, res) => {
  res.type("application/json").json(swaggerDocument);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", portal: "shipmozo-developer-portal", proxy: true });
});

app.get("/openapi.json", (_req, res) => {
  res.redirect(301, "/api/spec.json");
});

app.post("/api/proxy", async (req, res) => {
  const { method = "GET", path: apiPath, headers = {}, body } = req.body || {};
  if (!apiPath || typeof apiPath !== "string") {
    return res.status(400).json({ error: "path is required", data: null });
  }

  const normalized = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const pathOnly = normalized.split("?")[0];
  const queryPart = normalized.includes("?") ? "?" + normalized.split("?").slice(1).join("?") : "";

  const allowed = Object.keys(swaggerDocument.paths || {}).some((p) => {
    const pattern = "^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$";
    return new RegExp(pattern).test(pathOnly);
  });

  if (!allowed && pathOnly !== "/info") {
    return res.status(403).json({
      error: "Path not allowed",
      path: pathOnly,
      data: null,
      hint: "Use paths from this portal's API reference only.",
    });
  }

  const url = PRODUCTION_BASE + pathOnly + queryPart;
  const forwardHeaders = { Accept: "application/json" };

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    const k = key.toLowerCase();
    if (k === "public-key") forwardHeaders["public-key"] = value;
    else if (k === "private-key") forwardHeaders["private-key"] = value;
    else if (k === "authorization") forwardHeaders.Authorization = value;
  }

  try {
    const init = { method: method.toUpperCase(), headers: forwardHeaders };
    if (body && !["GET", "HEAD"].includes(init.method)) {
      forwardHeaders["Content-Type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const upstream = await fetch(url, init);
    const text = await upstream.text();
    const trimmed = text.trim();

    if (trimmed.startsWith("<!") || trimmed.startsWith("<html")) {
      return res.status(502).json({
        status: upstream.status,
        statusText: upstream.statusText,
        url,
        error: "UPSTREAM_HTML",
        message:
          "Shipmozo returned an HTML page instead of JSON. Check base URL (no trailing slash), API keys, and that the endpoint path is correct.",
        data: null,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { _raw: text };
    }

    const rateLimit = {
      limit: upstream.headers.get("x-ratelimit-limit"),
      remaining: upstream.headers.get("x-ratelimit-remaining"),
      observedAt: new Date().toISOString(),
    };

    res.status(upstream.status).json({
      status: upstream.status,
      statusText: upstream.statusText,
      url,
      data: parsed,
      rateLimit: rateLimit.limit || rateLimit.remaining ? rateLimit : undefined,
      rateLimitHeaders: {
        "x-ratelimit-limit": rateLimit.limit,
        "x-ratelimit-remaining": rateLimit.remaining,
      },
    });
  } catch (err) {
    res.status(502).json({
      error: "UPSTREAM_FAILED",
      message: err.message,
      url,
      data: null,
    });
  }
});

/** Static assets — exclude spec from public folder collisions */
app.use(
  express.static(publicDir, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith("openapi.json")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

app.get("/docs", (_req, res) => res.redirect("/"));

/** SPA fallback — only for HTML routes (never swallow /api/* or static assets) */
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/") || req.path === "/health") {
    return res.status(404).json({ error: "Not found", path: req.path });
  }
  if (req.path.includes(".")) return next();
  res.sendFile(path.join(publicDir, "index.html"));
});

/** Final 404 for missing static files */
app.use((_req, res) => {
  res.status(404).type("text/plain").send("Not found");
});

app.listen(PORT, HOST, () => {
  console.log(`Shipmozo Developer Portal: http://${HOST}:${PORT}/`);
  console.log(`API Tester:              http://${HOST}:${PORT}/#/execute`);
  console.log(`OpenAPI:                 http://${HOST}:${PORT}/api/spec.json`);
});
