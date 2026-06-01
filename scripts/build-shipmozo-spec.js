/**
 * Builds public/openapi.json from shipmozo-openapi.json with path fixes,
 * security schemes, and standard Shipmozo response/error schemas.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const raw = JSON.parse(fs.readFileSync(path.join(root, "shipmozo-openapi.json"), "utf8"));

const STANDARD_ERRORS = {
  businessFailure: {
    result: "0",
    message: "Order not found",
    data: {},
  },
  authFailure: {
    result: "0",
    message: "Invalid credentials",
    data: {},
  },
};

const components = {
  securitySchemes: {
    shipmozoKeys: {
      type: "apiKey",
      in: "header",
      name: "public-key",
      description:
        "Pair with private-key header. Obtain via POST /login or Shipmozo panel → Profile.",
    },
    shipmozoPrivateKey: {
      type: "apiKey",
      in: "header",
      name: "private-key",
    },
  },
  schemas: {
    ShipmozoEnvelope: {
      type: "object",
      properties: {
        result: {
          type: "string",
          enum: ["0", "1"],
          description: '"1" = success, "0" = failure (check message and data)',
        },
        message: { type: "string" },
        data: {},
      },
      required: ["result", "message"],
    },
    LoginRequest: {
      type: "object",
      required: ["username", "password"],
      properties: {
        username: { type: "string", description: "Panel email or phone" },
        password: { type: "string", format: "password" },
      },
    },
    ApiKeysData: {
      type: "object",
      properties: {
        name: { type: "string" },
        public_key: { type: "string" },
        private_key: { type: "string" },
      },
    },
  },
  responses: {
    ShipmozoSuccess: {
      description: "HTTP 200 with result=1 in body",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ShipmozoEnvelope" },
        },
      },
    },
    ShipmozoBusinessError: {
      description: "HTTP 200 with result=0 — validation or business rule failure",
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/ShipmozoEnvelope" },
          example: STANDARD_ERRORS.businessFailure,
        },
      },
    },
    Unauthorized: {
      description: "Missing or invalid API keys",
      content: {
        "application/json": {
          example: STANDARD_ERRORS.authFailure,
        },
      },
    },
    RateLimited: {
      description: "Too many requests (if enforced on account)",
      headers: {
        "Retry-After": { schema: { type: "integer" } },
      },
      content: {
        "application/json": {
          example: {
            result: "0",
            message: "Rate limit exceeded. Retry after the Retry-After period.",
            data: {},
          },
        },
      },
    },
  },
};

function fixPaths(paths) {
  const out = {};
  for (const [p, methods] of Object.entries(paths)) {
    let pathKey = p;
    if (pathKey.startsWith("/api/v1/")) pathKey = pathKey.replace("/api/v1", "");
    if (pathKey === "/api/v1/info") pathKey = "/info";
    out[pathKey] = methods;

    for (const [method, op] of Object.entries(methods)) {
      if (!op || typeof op !== "object") continue;
      const needsAuth = pathKey !== "/login" && pathKey !== "/info";
      if (needsAuth && !op.security) {
        op.security = [{ shipmozoKeys: [], shipmozoPrivateKey: [] }];
      }
      if (pathKey === "/login" || pathKey === "/info") {
        op.security = [];
      }

      op.responses = op.responses || {};
      if (!op.responses["401"]) op.responses["401"] = { $ref: "#/components/responses/Unauthorized" };
      if (!op.responses["429"]) op.responses["429"] = { $ref: "#/components/responses/RateLimited" };
      if (op.responses["200"] && !op.responses["200"].content) {
        op.responses["200"] = {
          description: op.responses["200"].description || "Successful operation",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ShipmozoEnvelope" },
            },
          },
        };
      }
      if (!op.responses["200"]) {
        op.responses["200"] = { $ref: "#/components/responses/ShipmozoSuccess" };
      }
      op.responses["422"] = { $ref: "#/components/responses/ShipmozoBusinessError" };

      op["x-shipmozo-rate-limit"] = op["x-shipmozo-rate-limit"] || "500 per shared API-key window (x-ratelimit-limit header)";
    }
  }
  return out;
}

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Shipmozo Shipping API",
    version: "1.0.0",
    description: [
      "REST API for order push, courier assignment, tracking, warehouses, labels, NDR, and returns.",
      "",
      "**Base URL:** `https://shipping-api.com/app/api/v1` (no trailing slash).",
      "",
      "**Authentication:** Send `public-key` and `private-key` headers on every request except `/login` and `/info`.",
      "",
      "**Response contract:** All endpoints return HTTP 200 with JSON `{ result, message, data }` where `result` is `\"1\"` (success) or `\"0\"` (failure).",
    ].join("\n"),
    contact: {
      name: "Shipmozo API Support",
      email: "munish@apporio.in",
    },
  },
  servers: raw.servers,
  tags: raw.tags,
  externalDocs: raw.externalDocs,
  components,
  paths: fixPaths(raw.paths),
};

fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.writeFileSync(path.join(root, "public", "openapi.json"), JSON.stringify(spec, null, 2));
console.log("Wrote public/openapi.json with", Object.keys(spec.paths).length, "paths");
