/**
 * Shipmozo rate limits — aligned with live API response headers (Swagger / production).
 * Official OpenAPI does not document per-path limits; x-ratelimit-limit is typically 500
 * for all authenticated routes on a shared per-key quota.
 */
const GLOBAL = {
  limit: 500,
  window: "1 minute",
  windowSeconds: 60,
  windowBehavior:
    "x-ratelimit-remaining only changes when Shipmozo sends a new HTTP response to you — it does not tick down on its own in the browser. Each API call lowers remaining by 1. After ~60 seconds, the next call you make usually shows remaining closer to 500 again (sliding window, not a live clock on the docs page).",
  responseHeaders: {
    limit: "x-ratelimit-limit",
    remaining: "x-ratelimit-remaining",
  },
  whenExceeded: "HTTP 429 and/or result=0 with rate-limit message — wait until remaining rises again (typically within ~1 minute)",
  source: "Observed on shipping-api.com production (Cloudflare); limit=500, remaining decrements per call and refills each minute",
};

/** Every Shipmozo v1 operation — limit applies to shared key quota unless noted */
const ENDPOINTS = [
  { operationId: "getApiInfo", method: "GET", path: "/info", tag: "Common", auth: false, limit: 500, notes: "No API keys; still returns rate-limit headers" },
  { operationId: "Login", method: "POST", path: "/login", tag: "Utility", auth: false, limit: 500, notes: "Cache keys after success; do not poll login" },
  { operationId: "Countries", method: "GET", path: "/countries", tag: "Utility", auth: true, limit: 500, notes: "International orders reference data" },
  { operationId: "pincodeServiceability", method: "POST", path: "/pincode-serviceability", tag: "Utility", auth: true, limit: 500, notes: "Checkout / pre-push validation" },
  { operationId: "getReturnReason", method: "GET", path: "/get-return-reason", tag: "Utility", auth: true, limit: 500, notes: "Before push-return-order" },
  { operationId: "rateCalculator", method: "POST", path: "/rate-calculator", tag: "Utility", auth: true, limit: 500, notes: "Rate shopping; shares 500 pool with all APIs" },
  { operationId: "internationalRateCalculator", method: "POST", path: "/international-rate-calculator", tag: "Utility", auth: true, limit: 500, notes: "International rate quotes" },
  { operationId: "createShipper", method: "POST", path: "/create-shipper", tag: "Utility", auth: true, limit: 500, notes: "Shipper profile setup" },
  { operationId: "trackOrder", method: "GET", path: "/track-order", tag: "Track", auth: true, limit: 500, notes: "Query param awb_number; prefer webhooks over tight polling" },
  { operationId: "getOrderLabel", method: "GET", path: "/get-order-label/{awb_number}", tag: "Label", auth: true, limit: 500, notes: "Returns base64 label PNG" },
  { operationId: "generateManifest", method: "GET", path: "/generate-manifest", tag: "Label", auth: true, limit: 500, notes: "Max 25 AWB numbers per request (comma-separated)" },
  { operationId: "pushOrders", method: "POST", path: "/push-order", tag: "Orders", auth: true, limit: 500, notes: "Create forward order" },
  { operationId: "internationalPushOrder", method: "POST", path: "/international-push-order", tag: "Orders", auth: true, limit: 500, notes: "International forward order" },
  { operationId: "pushReturnOrder", method: "POST", path: "/push-return-order", tag: "Orders", auth: true, limit: 500, notes: "Return / reverse pickup order" },
  { operationId: "assignCourier", method: "POST", path: "/assign-courier", tag: "Orders", auth: true, limit: 500, notes: "Manual courier from rate-calculator" },
  { operationId: "autoCourierAssign", method: "POST", path: "/auto-assign-order", tag: "Orders", auth: true, limit: 500, notes: "Requires panel auto-assign enabled" },
  { operationId: "schedulePickup", method: "POST", path: "/schedule-pickup", tag: "Orders", auth: true, limit: 500, notes: "When pickups_automatically_scheduled = NO" },
  { operationId: "cancelOrder", method: "POST", path: "/cancel-order", tag: "Orders", auth: true, limit: 500, notes: "order_id + awb_number required" },
  { operationId: "getOrderDetail", method: "GET", path: "/get-order-detail/{order_id}", tag: "Orders", auth: true, limit: 500, notes: "Order status snapshot" },
  { operationId: "getAllNdrShipments", method: "GET", path: "/get-ndr-all", tag: "Orders", auth: true, limit: 500, notes: "Paginated; per_page max 100" },
  { operationId: "ndrOrderAction", method: "POST", path: "/ndr-action/{awb_number}", tag: "Orders", auth: true, limit: 500, notes: "NDR reattempt / RTO actions" },
  { operationId: "getWarehouses", method: "GET", path: "/get-warehouses", tag: "Warehouse", auth: true, limit: 500, notes: "Optional ?page= for >25 warehouses" },
  { operationId: "createWarehouse", method: "POST", path: "/create-warehouse", tag: "Warehouse", auth: true, limit: 500, notes: "Unique address_title" },
  { operationId: "orderUpdateWarehouse", method: "POST", path: "/order/update-warehouse", tag: "Warehouse", auth: true, limit: 500, notes: "Change warehouse on existing order" },
];

const byOperationId = Object.fromEntries(ENDPOINTS.map((e) => [e.operationId, e]));

function getRateLimitMeta(operationId) {
  const ep = byOperationId[operationId];
  return {
    limit: ep?.limit ?? GLOBAL.limit,
    window: GLOBAL.window,
    headers: GLOBAL.responseHeaders,
    notes: ep?.notes ?? "",
    sharedQuota: true,
  };
}

function applyRateLimitsToSpec(spec) {
  const endpoints = [];

  for (const [pathKey, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (!op.operationId) continue;
      const meta = getRateLimitMeta(op.operationId);
      const ep = byOperationId[op.operationId];
      op["x-rateLimit"] = {
        limit: meta.limit,
        remainingHeader: "x-ratelimit-remaining",
        limitHeader: "x-ratelimit-limit",
        window: GLOBAL.window,
        windowSeconds: GLOBAL.windowSeconds,
        windowBehavior: GLOBAL.windowBehavior,
        sharedQuota: true,
        notes: meta.notes,
      };
      op.responses = op.responses || {};
      if (!op.responses["429"]) {
        op.responses["429"] = { $ref: "#/components/responses/RateLimited" };
      }
      endpoints.push({
        operationId: op.operationId,
        method: method.toUpperCase(),
        path: pathKey,
        tag: (op.tags && op.tags[0]) || ep?.tag || "Other",
        auth: ep?.auth ?? (op.operationId !== "Login" && op.operationId !== "getApiInfo"),
        limit: meta.limit,
        notes: meta.notes,
      });
    }
  }

  if (!spec["x-portal"]) spec["x-portal"] = {};
  spec["x-portal"].rateLimitGlobal = GLOBAL;
  spec["x-portal"].rateLimitsByEndpoint = endpoints.sort((a, b) =>
    `${a.tag}${a.path}`.localeCompare(`${b.tag}${b.path}`)
  );
  spec["x-portal"].rateLimits = { default: { limit: GLOBAL.limit, window: GLOBAL.window, source: "x-ratelimit-limit" } };

  return spec;
}

module.exports = { GLOBAL, ENDPOINTS, byOperationId, getRateLimitMeta, applyRateLimitsToSpec };
