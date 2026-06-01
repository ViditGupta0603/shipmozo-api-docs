/** Shipmozo API portal enrichment — flows, errors, rate limits, use cases */

export const API_BASE = "https://shipping-api.com/app/api/v1";

export const GLOBAL = {
  rateLimits: [
    {
      scope: "All endpoints (live API)",
      limit: "500 requests per 1-minute window per API key",
      burst: "x-ratelimit-remaining starts near 500, drops 1 per call, refills when the minute resets",
      note: "Observed: limit=500, remaining=498 after 2 calls. Wait ~60s for remaining to climb again if exhausted.",
    },
    {
      scope: "POST /login",
      limit: "Same 500 envelope; cache keys after first success",
      note: "Avoid hammering login; store public_key / private_key server-side.",
    },
    {
      scope: "When exceeded",
      limit: "HTTP 429 or result=0 with rate-limit message",
      note: "Backoff exponentially; honor Retry-After if present.",
    },
  ],
  errorModel: {
    title: "Response envelope (all APIs)",
    description:
      'Every response uses `{ "result": "1"|"0", "message": string, "data": object|array }`. HTTP status is often 200 even on business failure — always check `result`.',
  },
  errorCodes: [
    { code: 'result="0"', http: "200", meaning: "Business/validation failure", action: "Read message and data.error; fix request and retry" },
    { code: "AUTH_KEYS_MISSING", http: "401", meaning: "public-key or private-key header absent", action: "Login via /login or paste keys from panel profile" },
    { code: "AUTH_KEYS_INVALID", http: "401", meaning: "Keys rejected", action: "Regenerate keys in panel; update stored credentials" },
    { code: "ORDER_NOT_FOUND", http: "200", meaning: "order_id unknown", action: "Push order first; verify order_id matches your store" },
    { code: "ORDER_ALREADY_ASSIGNED", http: "200", meaning: "Courier already assigned", action: "Use track-order or cancel before re-assign" },
    { code: "AUTO_ASSIGN_NOT_CONFIGURED", http: "200", meaning: "Panel auto-assign not set", action: 'Enable Settings → Auto assign or use assign-courier' },
    { code: "PICKUP_AUTO_SCHEDULED", http: "200", meaning: "Manual schedule-pickup not needed", action: "Skip schedule-pickup when rate-calculator returns pickups_automatically_scheduled=YES" },
    { code: "PINCODE_NOT_SERVICEABLE", http: "200", meaning: "Lane not serviceable", action: "Call pincode-serviceability before push-order" },
    { code: "WAREHOUSE_REQUIRED", http: "200", meaning: "Invalid/missing warehouse_id", action: "create-warehouse or get-warehouses" },
    { code: "CORS_TRAILING_SLASH", http: "—", meaning: "Base URL has trailing /", action: "Use https://shipping-api.com/app/api/v1 without trailing slash" },
    { code: "RATE_LIMIT", http: "429", meaning: "Too many requests", action: "Exponential backoff; honor Retry-After if present" },
  ],
  workflows: [
    {
      id: "forward-manual",
      title: "Forward shipment (manual courier)",
      steps: [
        "POST /login → store public_key & private_key",
        "GET /info (health)",
        "POST /pincode-serviceability",
        "POST /create-warehouse (once) or GET /get-warehouses",
        "POST /rate-calculator → pick courier_id",
        "POST /push-order",
        "POST /assign-courier",
        "If pickups_automatically_scheduled=NO → POST /schedule-pickup",
        "GET /get-order-label/{awb_number}",
        "GET /track-order?awb_number=",
      ],
    },
    {
      id: "forward-auto",
      title: "Forward shipment (auto-assign)",
      steps: [
        "Configure panel: Settings → Auto assign",
        "POST /push-order",
        "POST /auto-assign-order → awb_number in response",
        "GET /track-order",
      ],
    },
    {
      id: "return",
      title: "Return (RTO / customer return)",
      steps: [
        "GET /get-return-reason → return_reason_id",
        "POST /push-return-order",
        "POST /rate-calculator (shipment_type RETURN)",
        "POST /assign-courier or /auto-assign-order",
      ],
    },
    {
      id: "cancel",
      title: "Cancel before dispatch",
      steps: ["POST /cancel-order with order_id + awb_number"],
    },
    {
      id: "ndr",
      title: "NDR handling",
      steps: [
        "GET /get-ndr-all (filter by date/page)",
        "POST /ndr-action/{awb_number}?action=REATTEMPT|RETURN",
      ],
    },
  ],
};

/** Per operationId — use cases, errors, rate limit override */
export const ENDPOINTS = {
  getApiInfo: {
    rateLimit: "500 (shared quota; x-ratelimit-limit)",
    useCases: ["Health check before batch jobs", "Verify API version in monitoring"],
    errors: [{ when: "Network failure", message: "Connection timeout", fix: "Retry with backoff" }],
  },
  Login: {
    rateLimit: "500 (shared quota; cache keys after login)",
    useCases: ["Obtain API keys programmatically", "Rotate keys after panel reset"],
    errors: [
      { when: "Invalid username/password", message: "Success with result=0 or auth error", fix: "Use panel credentials" },
    ],
    notes: ["Response data[0] contains public_key and private_key — store securely server-side."],
  },
  pincodeServiceability: {
    rateLimit: "500 (shared quota)",
    useCases: ["Checkout pincode validation", "Pre-quote serviceability"],
    errors: [{ when: "Invalid pincode", message: "serviceable: false", fix: "Try alternate hub or courier" }],
  },
  pushOrders: {
    rateLimit: "500 (shared quota)",
    useCases: ["Sync e-commerce order to Shipmozo", "COD and prepaid orders"],
    errors: [
      { when: "Duplicate order_id", message: "Order already exists", fix: "Use unique order_id per shipment" },
      { when: "Missing warehouse_id", message: "Validation error", fix: "Set warehouse from get-warehouses" },
      { when: "Invalid payment_type", message: "Must be PREPAID or COD", fix: "Send cod_amount for COD" },
    ],
    notes: ["weight is in grams", "order_id must match your storefront ID"],
  },
  pushReturnOrder: {
    rateLimit: "500 (shared quota)",
    useCases: ["Customer-initiated returns", "Reverse logistics"],
    errors: [
      { when: "Invalid return_reason_id", message: "Unknown reason", fix: "GET /get-return-reason first" },
    ],
    notes: ["weight in PDF is kg for returns — confirm with your account manager if unsure"],
  },
  assignCourier: {
    rateLimit: "500 (shared quota)",
    useCases: ["Select cheapest/fastest courier from rate-calculator"],
    errors: [
      { when: "Invalid courier_id", message: "Courier not available", fix: "Re-run rate-calculator" },
      { when: "Order not pushed", message: "Order not found", fix: "POST /push-order first" },
    ],
  },
  schedulePickup: {
    rateLimit: "500 (shared quota)",
    useCases: ["Manual pickup when auto schedule is NO"],
    errors: [
      { when: "Order not found", message: "Order not found", fix: "Verify order_id" },
      { when: "Auto pickup enabled", message: "Pickup already scheduled", fix: "Skip this API" },
    ],
  },
  cancelOrder: {
    rateLimit: "500 (shared quota)",
    useCases: ["Customer cancellation before pickup"],
    errors: [{ when: "Already picked up", message: "Cannot cancel", fix: "Contact support / NDR flow" }],
  },
  autoCourierAssign: {
    rateLimit: "500 (shared quota)",
    useCases: ["Hands-free courier + AWB assignment"],
    errors: [
      { when: "Auto assign off", message: "please setup auto assign", fix: "Enable in panel Settings → Auto assign" },
    ],
  },
  trackOrder: {
    rateLimit: "500 (shared quota; avoid tight polling)",
    useCases: ["Customer tracking page", "Webhook fallback polling"],
    errors: [{ when: "Invalid AWB", message: "No tracking data", fix: "Confirm awb_number from assign response" }],
  },
  getOrderLabel: {
    rateLimit: "500 (shared quota)",
    useCases: ["Print shipping label", "Pass ?type_of_label=PDF for PDF format"],
    errors: [{ when: "AWB not generated", message: "Label not available", fix: "Complete assign-courier first" }],
  },
  rateCalculator: {
    rateLimit: "500 (shared quota)",
    useCases: ["Checkout shipping quotes", "Compare couriers before assign"],
    errors: [{ when: "Unserviceable lane", message: "Empty or error in data", fix: "Use pincode-serviceability first" }],
    notes: ["Check pickups_automatically_scheduled in response for schedule-pickup decision"],
  },
  getReturnReason: {
    rateLimit: "500 (shared quota)",
    useCases: ["Populate return UI dropdown"],
    errors: [],
  },
  getWarehouses: {
    rateLimit: "500 (shared quota)",
    useCases: ["Warehouse picker in OMS", "Default warehouse for push-order"],
    errors: [],
    notes: ["Use ?page= for next 25 records"],
  },
  createWarehouse: {
    rateLimit: "500 (shared quota)",
    useCases: ["Onboard new fulfillment location"],
    errors: [
      { when: "Duplicate address_title", message: "Returns existing warehouse_id", fix: "Idempotent — reuse returned id" },
    ],
  },
  orderUpdateWarehouse: {
    rateLimit: "500 (shared quota)",
    useCases: ["Re-route order to different FC before dispatch"],
    errors: [{ when: "Invalid warehouse_id", message: "Warehouse not found", fix: "GET /get-warehouses" }],
  },
  getOrderDetail: {
    rateLimit: "500 (shared quota)",
    useCases: ["Order status sync", "Support desk lookup"],
    errors: [{ when: "Unknown order_id", message: "Order not found", fix: "Verify order_id" }],
  },
  generateManifest: {
    rateLimit: "500 (shared quota; max 25 AWBs per call)",
    useCases: ["Bulk handover manifest for courier pickup"],
    errors: [{ when: ">25 AWBs", message: "Limit exceeded", fix: "Split into batches of 25" }],
  },
  getAllNdrShipments: {
    rateLimit: "500 (shared quota)",
    useCases: ["NDR dashboard", "Exception queue"],
    errors: [],
  },
  ndrOrderAction: {
    rateLimit: "500 (shared quota)",
    useCases: ["Reattempt delivery", "Initiate return from NDR"],
    errors: [
      { when: "Invalid action", message: "action must be REATTEMPT or RETURN", fix: "Use query param action=" },
    ],
  },
  Countries: {
    rateLimit: "500 (shared quota)",
    useCases: ["International order forms"],
    errors: [],
  },
  createShipper: {
    rateLimit: "500 (shared quota)",
    useCases: ["Register shipper profile for international"],
    errors: [],
  },
  internationalPushOrder: {
    rateLimit: "500 (shared quota)",
    useCases: ["Cross-border order push"],
    errors: [],
  },
  internationalRateCalculator: {
    rateLimit: "500 (shared quota)",
    useCases: ["International shipping quotes"],
    errors: [],
  },
};

export function metaFor(operationId) {
  return ENDPOINTS[operationId] || {
    rateLimit: "500 (shared quota)",
    useCases: ["See API description"],
    errors: [{ when: "result=0", message: "See message field", fix: "Correct request per parameter table" }],
  };
}

export const AUTH_STORAGE_KEY = "shipmozo_api_credentials";

export function loadCredentials() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { publicKey: "", privateKey: "", username: "" };
  } catch {
    return { publicKey: "", privateKey: "", username: "" };
  }
}

export function saveCredentials(creds) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(creds));
}
