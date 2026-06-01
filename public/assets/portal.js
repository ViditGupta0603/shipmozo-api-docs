const PRODUCTION_BASE = "https://appiify.com/app/api/v1";
const AUTH_STORAGE = "shipmozo_api_keys";
/** Static file works even when a generic static server is used; /api/spec.json needs node server.js */
const SPEC_URLS = ["/assets/spec.json", "/api/spec.json"];

let spec = null;
let portalMeta = null;
let operations = [];
let credentials = { publicKey: "", privateKey: "" };

const $ = (sel, root = document) => root.querySelector(sel);

function toast(message, type = "info") {
  const host = $("#toastHost");
  if (!host) return;
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/** Parse JSON safely — surfaces HTML/login-page responses clearly */
async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("<!") || trimmed.startsWith("<html")) {
    throw new Error(
      "Server returned HTML instead of JSON. Run the portal with npm start from the logistics-api folder (not an old process on port 3000)."
    );
  }
  let data;
  try {
    data = trimmed ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON (${res.status}): ${trimmed.slice(0, 120)}…`);
  }
  return { res, data };
}

function getActiveCredentials() {
  const pub = $("#authPublicKey")?.value?.trim();
  const priv = $("#authPrivateKey")?.value?.trim();
  return {
    publicKey: pub || credentials.publicKey,
    privateKey: priv || credentials.privateKey,
  };
}

async function proxyRequest({ method, path, headers = {}, body }) {
  const { res, data } = await fetchJson("/api/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, path, headers, body }),
  });
  if (!res.ok && data.error && !data.data) {
    throw new Error(data.message || data.error);
  }
  return data;
}

/** Lightweight ping to read current x-ratelimit-* from Shipmozo (uses one request from your quota). */
async function fetchLiveRateLimit() {
  const headers = authHeaders();
  const path = headers["public-key"] ? "/get-warehouses" : "/info";
  const wrapped = await proxyRequest({ method: "GET", path, headers });
  return {
    rateLimit: wrapped.rateLimit,
    rateLimitHeaders: wrapped.rateLimitHeaders,
    via: path,
  };
}

function renderLiveRateLimitBox() {
  return `
    <div class="rate-live card" id="rateLiveBox">
      <div class="rate-live-head">
        <h3>Live rate limit</h3>
        <button type="button" class="btn-secondary btn-sm" id="rateLiveBtn">Check now</button>
      </div>
      <p class="muted small">Makes one real API call and reads <code>x-ratelimit-*</code> headers. The number does <strong>not</strong> update until you click again.</p>
      <div class="rate-live-values" id="rateLiveValues">Not checked yet</div>
    </div>`;
}

function bindLiveRateLimit(root) {
  const btn = root.querySelector("#rateLiveBtn");
  const out = root.querySelector("#rateLiveValues");
  if (!btn || !out) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    out.textContent = "Calling Shipmozo…";
    try {
      const live = await fetchLiveRateLimit();
      const rl = live.rateLimit;
      if (!rl?.limit) {
        out.innerHTML = `<span class="error-text">No rate-limit headers returned (via ${esc(live.via)})</span>`;
        return;
      }
      out.innerHTML = `
        <div class="rate-live-big"><strong>${esc(String(rl.remaining))}</strong> / ${esc(String(rl.limit))} remaining</div>
        <div class="muted small">Observed: ${esc(rl.observedAt || "now")} · via <code>${esc(live.via)}</code></div>
        <div class="muted small">Execute again after ~60s to see remaining recover toward 500.</div>`;
    } catch (e) {
      out.innerHTML = `<span class="error-text">${esc(e.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  });
}

function loadCredentials() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw);
      credentials = {
        publicKey: parsed.publicKey || "",
        privateKey: parsed.privateKey || "",
      };
    }
  } catch {
    credentials = { publicKey: "", privateKey: "" };
  }
  syncAuthUI();
}

function saveCredentials() {
  localStorage.setItem(AUTH_STORAGE, JSON.stringify(credentials));
  syncAuthUI();
}

function clearCredentials() {
  credentials = { publicKey: "", privateKey: "" };
  localStorage.removeItem(AUTH_STORAGE);
  syncAuthUI();
}

function syncAuthUI(accountHint) {
  const status = $("#authStatus");
  const pub = $("#authPublicKey");
  const priv = $("#authPrivateKey");
  if (pub) pub.value = credentials.publicKey;
  if (priv) priv.value = credentials.privateKey;
  const active = getActiveCredentials();
  status.classList.remove("connected", "pending");

  if (active.publicKey && active.privateKey) {
    if (accountHint === "verified") {
      status.textContent = "Ready";
      status.classList.add("connected");
      status.title = "Keys saved — account active";
    } else if (accountHint === "pending") {
      status.textContent = "Pending verification";
      status.classList.add("pending");
      status.title = "Keys work, but Shipmozo profile is under verification";
    } else {
      status.textContent = "Keys saved";
      status.classList.add("connected");
      status.title = `public-key: ${active.publicKey.slice(0, 10)}…`;
    }
  } else if (active.publicKey || active.privateKey) {
    status.textContent = "Incomplete keys";
    status.title = "Enter both public-key and private-key";
  } else {
    status.textContent = "Not connected";
    status.title = "Click Connect API";
  }
}

/** Explain Shipmozo result/message in plain language */
function interpretShipmozoResponse(payload) {
  if (!payload || typeof payload !== "object") return null;
  const msg = (payload.message || "").toLowerCase();
  if (payload.result === "1") {
    return { type: "ok", title: "Success", text: payload.message || "Request succeeded." };
  }
  if (msg.includes("under verification") || msg.includes("profile is under")) {
    return {
      type: "pending",
      title: "Account pending verification (not an API key issue)",
      text: "Your public-key and private-key are accepted, but Shipmozo has not activated your seller profile yet. Complete verification in the Shipmozo panel (KYC / documents). API calls will return result \"0\" until approval.",
    };
  }
  if (msg.includes("invalid") && (msg.includes("key") || msg.includes("credential"))) {
    return {
      type: "error",
      title: "Invalid API keys",
      text: "Shipmozo rejected the keys. Copy fresh keys from Panel → Profile or sign in again.",
    };
  }
  return {
    type: "error",
    title: "Request failed",
    text: payload.message || "result is 0 — see response data for details.",
  };
}

async function probeAccountStatus() {
  const headers = authHeaders();
  if (!headers["public-key"] || !headers["private-key"]) return null;
  try {
    const wrapped = await proxyRequest({
      method: "GET",
      path: "/get-warehouses",
      headers,
    });
    const payload = wrapped.data;
    if (payload?.result === "1") return "verified";
    const hint = interpretShipmozoResponse(payload);
    if (hint?.type === "pending") return "pending";
    return "unknown";
  } catch {
    return null;
  }
}

async function loginWithPassword(username, password) {
  const wrapped = await proxyRequest({
    method: "POST",
    path: "/login",
    headers: {},
    body: { username, password },
  });
  const payload = wrapped.data;
  if (payload?.result !== "1" || !Array.isArray(payload.data) || !payload.data[0]) {
    throw new Error(payload?.message || wrapped.message || "Login failed");
  }
  credentials.publicKey = payload.data[0].public_key || "";
  credentials.privateKey = payload.data[0].private_key || "";
  saveCredentials();
  return payload.data[0];
}

function authHeaders() {
  const c = getActiveCredentials();
  const h = {};
  if (c.publicKey) h["public-key"] = c.publicKey;
  if (c.privateKey) h["private-key"] = c.privateKey;
  return h;
}

async function loadSpec() {
  let lastError;
  for (const url of SPEC_URLS) {
    try {
      const { data } = await fetchJson(url);
      if (!data?.paths) throw new Error("Spec missing paths");
      spec = data;
      portalMeta = spec["x-portal"] || {};
      operations = [];
      for (const [pathKey, methods] of Object.entries(spec.paths || {})) {
        for (const [method, op] of Object.entries(methods)) {
          if (["get", "post", "put", "patch", "delete"].includes(method)) {
            operations.push({
              id: `${method}-${pathKey}`.replace(/[{}]/g, ""),
              method: method.toUpperCase(),
              path: pathKey,
              op,
              tag: (op.tags && op.tags[0]) || "Other",
              summary: op.summary || pathKey,
            });
          }
        }
      }
      return;
    } catch (e) {
      lastError = new Error(`${url}: ${e.message}`);
    }
  }
  throw lastError || new Error("Could not load API spec");
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function resolveRef(ref) {
  if (!ref || !ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let cur = spec;
  for (const p of parts) cur = cur?.[p];
  return cur;
}

function schemaFromProperties(props) {
  if (!props) return null;
  const o = {};
  for (const [k, v] of Object.entries(props)) {
    if (v.default !== undefined && v.default !== "") o[k] = v.default;
    else if (v.example !== undefined) o[k] = v.example;
    else if (v.type === "array") o[k] = v.example || [];
    else if (v.type === "number") o[k] = 0;
    else o[k] = "";
  }
  return o;
}

function getRequestExample(op) {
  const content = op.requestBody?.content?.["application/json"];
  if (!content) return null;
  const ex = content.examples && Object.values(content.examples)[0]?.value;
  if (ex) return ex;
  const schema = content.schema?.$ref ? resolveRef(content.schema.$ref) : content.schema;
  if (schema?.properties) return schemaFromProperties(schema.properties);
  return schemaExample(schema);
}

function schemaExample(schema, depth = 0) {
  if (!schema || depth > 4) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.$ref) schema = resolveRef(schema.$ref) || schema;
  if (schema.properties) return schemaFromProperties(schema.properties);
  if (schema.type === "array") return [schemaExample(schema.items, depth + 1)];
  if (schema.type === "integer" || schema.type === "number") return 0;
  if (schema.type === "boolean") return true;
  return schema.type === "string" ? "" : null;
}

function getResponseExample(op, status = "200") {
  const resp = op.responses?.[status];
  const content = resp?.content?.["application/json"];
  if (!content) return null;
  if (content.schema?.example) return content.schema.example;
  return schemaExample(content.schema);
}

function collectParams(op, path) {
  const params = [];
  const add = (p) => {
    if (!p) return;
    const resolved = p.$ref ? resolveRef(p.$ref) : p;
    if (resolved) params.push(resolved);
  };
  (op.parameters || []).forEach(add);
  const pathParams = path.match(/\{([^}]+)\}/g) || [];
  pathParams.forEach((m) => {
    const name = m.slice(1, -1);
    if (!params.find((x) => x.name === name && x.in === "path")) {
      params.push({ name, in: "path", required: true, schema: { type: "string" } });
    }
  });
  return params;
}

function needsAuth(op) {
  return op.security !== undefined && op.security.length > 0;
}

function buildCurl(method, url, headers, body) {
  let s = `curl -X ${method} "${url}"`;
  for (const [k, v] of Object.entries(headers)) {
    if (v) s += ` \\\n  -H "${k}: ${v}"`;
  }
  if (body)
    s += ` \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
  return s;
}

function buildNode(method, url, headers, body) {
  const opts = { method, headers: { ...headers, Accept: "application/json" } };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = "JSON.stringify(payload)";
  }
  return `const payload = ${JSON.stringify(body || {}, null, 2)};
const res = await fetch("${url}", ${JSON.stringify(opts, null, 2).replace('"JSON.stringify(payload)"', "JSON.stringify(payload)")});
const data = await res.json();
console.log(data);`;
}

function buildPython(method, url, headers, body) {
  const h = JSON.stringify(headers, null, 4);
  if (body) {
    return `import requests\n\npayload = ${JSON.stringify(body, null, 4)}\nheaders = ${h}\nr = requests.${method.toLowerCase()}("${url}", json=payload, headers=headers)\nprint(r.status_code, r.json())`;
  }
  return `import requests\n\nheaders = ${h}\nr = requests.${method.toLowerCase()}("${url}", headers=headers)\nprint(r.status_code, r.json())`;
}

function renderCodeTabs(curl, node, python) {
  const id = "code-" + Math.random().toString(36).slice(2, 9);
  const tabs = [
    ["cURL", curl],
    ["Node.js", node],
    ["Python", python],
  ];
  return `
    <div class="code-tabs" data-tabs="${id}">
      <div class="code-tab-bar">
        ${tabs.map(([name], i) => `<button type="button" class="code-tab${i === 0 ? " active" : ""}" data-tab="${i}">${name}</button>`).join("")}
      </div>
      ${tabs
        .map(
          ([, code], i) => `
        <div class="code-block-wrap${i === 0 ? "" : " hidden"}" data-panel="${i}">
          <button type="button" class="copy-btn" data-copy>Copy</button>
          <pre><code>${esc(code)}</code></pre>
        </div>`
        )
        .join("")}
    </div>`;
}

function bindCodeTabs(root) {
  root.querySelectorAll("[data-tabs]").forEach((wrap) => {
    const panels = wrap.querySelectorAll("[data-panel]");
    wrap.querySelectorAll(".code-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = btn.dataset.tab;
        wrap.querySelectorAll(".code-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === i));
        panels.forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== i));
      });
    });
    wrap.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pre = btn.parentElement.querySelector("pre code");
        navigator.clipboard.writeText(pre.textContent);
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = "Copy"), 1500);
      });
    });
  });
}

function renderParamTable(params) {
  if (!params.length) return "<p class='muted'>No parameters.</p>";
  return `<table>
    <thead><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
    <tbody>
      ${params
        .map((p) => {
          const req = p.required ? '<span class="tag-required">Required</span>' : "Optional";
          const type = p.schema?.type || p.schema?.format || "—";
          return `<tr>
            <td><code>${esc(p.name)}</code></td>
            <td>${esc(p.in)}</td>
            <td>${esc(String(type))}</td>
            <td>${req}</td>
            <td>${esc(p.description || "")}</td>
          </tr>`;
        })
        .join("")}
    </tbody>
  </table>`;
}

function formatRateLimitLine(op) {
  const rl = op?.["x-rateLimit"];
  const g = portalMeta.rateLimitGlobal;
  const limit = typeof rl === "object" ? rl.limit : g?.limit ?? 500;
  const window = g?.window || "1 minute";
  return `${limit} requests / ${window} (shared) · remaining refills each minute`;
}

function renderRateLimitByEndpointTable() {
  const rows = portalMeta.rateLimitsByEndpoint || [];
  if (!rows.length) return "";
  return `<table class="rate-api-table">
    <thead><tr><th>Method</th><th>Path</th><th>Limit</th><th>Auth</th><th>Notes</th></tr></thead>
    <tbody>
      ${rows
        .map(
          (r) => `<tr>
          <td><span class="method-badge method-${r.method}">${r.method}</span></td>
          <td><code>${esc(r.path)}</code></td>
          <td><strong>${r.limit}</strong> <span class="muted small">(shared)</span></td>
          <td>${r.auth ? "Keys" : "—"}</td>
          <td class="muted small">${esc(r.notes || "")}</td>
        </tr>`
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderStaticIntro() {
  const g = portalMeta.rateLimitGlobal || { limit: 500 };
  const rlHeaders = portalMeta.rateLimitHeaders;
  return `
    <div class="hero-banner">
      <div class="hero-logo-wrap">
        <img src="/assets/shipmozo-logo.png" alt="Shipmozo" class="hero-logo" width="160" height="52" />
      </div>
      <h2>Developer portal</h2>
      <p>Integrate orders, couriers, tracking, warehouses, and returns. Connect your API keys and test live from the browser.</p>
      <div class="hero-actions">
        <button type="button" class="btn-primary" id="heroConnectBtn">Connect API keys</button>
        <a href="#/execute" class="btn-secondary">Open API Tester</a>
      </div>
    </div>

    <div class="section">
      <h2>What you can build</h2>
      <div class="card-grid">
        <div class="card"><h3>Forward orders</h3><p>Push orders, compare rates, assign courier, schedule pickup, print labels.</p></div>
        <div class="card"><h3>Returns</h3><p>Return reasons, push return orders, track reverse logistics.</p></div>
        <div class="card"><h3>Operations</h3><p>Warehouses, NDR actions, manifests, international shipments.</p></div>
      </div>
    </div>

    <div class="section">
      <h2>Base URL</h2>
      <div class="url-box card">
        <label>Production</label>
        <code>${PRODUCTION_BASE}</code>
      </div>
      <div class="note warn"><strong>No trailing slash.</strong> Using <code>.../v1/</code> can cause CORS failures in browsers.</div>
    </div>

    <div class="section">
      <h2>Response format</h2>
      <p>Every API returns JSON with three fields:</p>
      <table>
        <thead><tr><th>Field</th><th>Values</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>result</code></td><td><code>"1"</code> / <code>"0"</code></td><td>Success vs failure (check this first)</td></tr>
          <tr><td><code>message</code></td><td>string</td><td>Human-readable outcome</td></tr>
          <tr><td><code>data</code></td><td>object / array</td><td>Payload or error details</td></tr>
        </tbody>
      </table>
    </div>

    <div class="section">
      <h2>Rate limits</h2>
      <p>All <strong>24 APIs</strong> share <strong>${g.limit || 500} requests per minute</strong> per API key. Each call lowers <code>x-ratelimit-remaining</code> by 1; when the minute ends, the counter <strong>refreshes</strong> back toward 500.</p>
      ${
        rlHeaders
          ? `<table style="margin-top:12px"><thead><tr><th>Header</th><th>Example</th><th>Meaning</th></tr></thead><tbody>${rlHeaders.headers
              .map((h) => `<tr><td><code>${esc(h.name)}</code></td><td>${esc(h.example)}</td><td>${esc(h.meaning)}</td></tr>`)
              .join("")}</tbody></table>`
          : ""
      }
      <p style="margin-top:16px"><a href="#/rate-limits">Per-API rate limit table →</a> · <a href="#/errors">Error codes →</a></p>
    </div>

    <div class="section">
      <h2>Quick start</h2>
      <ol>
        <li>Sign in via the sidebar (or paste keys from Shipmozo panel → Profile).</li>
        <li>Open <a href="#/workflows">Integration flows</a> and pick your use case.</li>
        <li>Use <a href="#/execute">API Tester</a> — credentials are sent automatically.</li>
      </ol>
    </div>`;
}

function renderAuthPage() {
  return `
    <h1 class="page-title">Authentication</h1>
    <p class="page-lead">Shipmozo uses API key headers on every protected request. Keys are never sent as query parameters.</p>

    <div class="section">
      <h2>Option 1 — Login API (recommended for setup)</h2>
      <p>Exchange panel username and password for keys. Use the sidebar <strong>Sign in</strong> in this portal — keys are stored locally and attached to every test request.</p>
      ${renderCodeTabs(
        buildCurl("POST", `${PRODUCTION_BASE}/login`, {}, { username: "your_username", password: "your_password" }),
        buildNode("POST", `${PRODUCTION_BASE}/login`, {}, { username: "your_username", password: "your_password" }),
        buildPython("POST", `${PRODUCTION_BASE}/login`, {}, { username: "your_username", password: "your_password" })
      )}
      <p>Success response includes <code>public_key</code> and <code>private_key</code> inside <code>data[0]</code>.</p>
    </div>

    <div class="section">
      <h2>Option 2 — Panel profile</h2>
      <p>Log into the Shipmozo panel → User profile → copy <code>public-key</code> and <code>private-key</code>.</p>
    </div>

    <div class="section">
      <h2>Send keys on every request</h2>
      ${renderCodeTabs(
        buildCurl("GET", `${PRODUCTION_BASE}/get-warehouses`, { "public-key": "YOUR_PUBLIC_KEY", "private-key": "YOUR_PRIVATE_KEY" }, null),
        buildNode("GET", `${PRODUCTION_BASE}/get-warehouses`, { "public-key": "YOUR_PUBLIC_KEY", "private-key": "YOUR_PRIVATE_KEY" }, null),
        buildPython("GET", `${PRODUCTION_BASE}/get-warehouses`, { "public-key": "YOUR_PUBLIC_KEY", "private-key": "YOUR_PRIVATE_KEY" }, null)
      )}
    </div>

    <div class="note"><strong>Security:</strong> Never expose <code>private-key</code> in front-end apps or mobile clients. Call Shipmozo from your backend only.</div>`;
}

function renderWorkflows() {
  const flows = portalMeta.workflows || [];
  return `
    <h1 class="page-title">Integration flows</h1>
    <p class="page-lead">End-to-end sequences.</p>
    ${flows
      .map(
        (f) => `
      <div class="section flow-card">
        <h2>${esc(f.title)}</h2>
        <ol class="flow-steps">
          ${f.steps.map((s) => `<li><code>${esc(s)}</code></li>`).join("")}
        </ol>
      </div>`
      )
      .join("")}
    <div class="section">
      <h2>Glossary</h2>
      ${renderParamTable(
        (portalMeta.glossary || []).map((g) => ({
          name: g.term,
          in: "—",
          schema: { type: "term" },
          required: false,
          description: g.meaning,
        }))
      )}
    </div>`;
}

function renderRateLimitsPage() {
  const g = portalMeta.rateLimitGlobal || {};
  const rlHeaders = portalMeta.rateLimitHeaders;
  return `
    <h1 class="page-title">Rate limits — all APIs</h1>
    <p class="page-lead">Every Shipmozo v1 endpoint shares <strong>500 requests per minute</strong> per API key. <code>x-ratelimit-remaining</code> is returned on each response — it is <strong>not</strong> a live timer on this page.</p>

    ${renderLiveRateLimitBox()}

    <div class="section">
      <h2>How the 1-minute window works</h2>
      <div class="note warn" style="margin-bottom:16px"><strong>Why it looks "stuck" at 498:</strong> Documentation examples use 498 to mean "2 calls used." The real value only updates when you <strong>make another API request</strong> and read the new headers — not by waiting on this page.</div>
      <ol>
        <li><strong>Each API call you make:</strong> <code>remaining</code> decreases by 1 in that response</li>
        <li><strong>Wait ~60s, then call again:</strong> next response usually shows <code>remaining</code> higher (e.g. 499–500)</li>
        <li><strong>Docs / examples:</strong> static text — use <strong>Check now</strong> or API Tester for live values</li>
        <li><strong>If you hit 0:</strong> wait and retry; you may get HTTP 429 until the window recovers</li>
      </ol>
      <p class="muted small">${esc(g.windowBehavior || "")}</p>
    </div>

    <div class="section">
      <h2>Response headers</h2>
      ${
        rlHeaders
          ? `<table><thead><tr><th>Header</th><th>Example</th><th>Meaning</th></tr></thead><tbody>${rlHeaders.headers
              .map((h) => `<tr><td><code>${esc(h.name)}</code></td><td>${esc(h.example)}</td><td>${esc(h.meaning)}</td></tr>`)
              .join("")}</tbody></table><p class="note" style="margin-top:12px">${esc(rlHeaders.note || "")}</p>`
          : ""
      }
      <p><strong>Shared quota:</strong> All endpoints use the same <code>remaining</code> counter for your key within each 1-minute window.</p>
      <p><strong>When exceeded:</strong> ${esc(g.whenExceeded || "HTTP 429")}</p>
    </div>

    <div class="section">
      <h2>Per-endpoint reference (24 APIs)</h2>
      ${renderRateLimitByEndpointTable()}
    </div>`;
}

function renderErrors() {
  const codes = portalMeta.errorCodes || [];
  return `
    <h1 class="page-title">Error codes &amp; troubleshooting</h1>
    <p class="page-lead">Shipmozo returns HTTP 200 with <code>result: "0"</code> for business errors. Use <code>message</code> and <code>data.error</code> for details.</p>
    <p><a href="#/rate-limits">View all API rate limits →</a></p>

    <div class="section">
      <h2>Error reference</h2>
      <table class="error-table">
        <thead><tr><th>Code</th><th>result</th><th>Typical message</th><th>When</th><th>Action</th></tr></thead>
        <tbody>
          ${codes
            .map(
              (e) => `<tr>
              <td><code>${esc(e.code)}</code></td>
              <td>${esc(e.result)}</td>
              <td>${esc(e.typicalMessage)}</td>
              <td>${esc(e.when)}</td>
              <td>${esc(e.action)}</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function renderBestPractices() {
  return `
    <h1 class="page-title">Best practices</h1>
    <div class="section">
      <ol>
        <li>Always check <code>result === "1"</code> before reading <code>data</code>.</li>
        <li>Use unique <code>order_id</code> values from your OMS — they are the join key across APIs.</li>
        <li>Call <code>pincode-serviceability</code> and <code>rate-calculator</code> before <code>push-order</code> at checkout.</li>
        <li>Store <code>awb_number</code> from assign / auto-assign for tracking and labels.</li>
        <li>If <code>pickups_automatically_scheduled</code> is <code>NO</code>, call <code>schedule-pickup</code> after assign.</li>
        <li>Implement exponential backoff on rate-limit and 5xx responses.</li>
        <li>Keep <code>private-key</code> on server-side only.</li>
      </ol>
    </div>`;
}

function renderEndpoint(item) {
  const { method, path, op } = item;
  const params = collectParams(op, path);
  const bodyExample = getRequestExample(op);
  const fullUrl = PRODUCTION_BASE + path;
  const headers = { ...authHeaders(), "public-key": "YOUR_PUBLIC_KEY", "private-key": "YOUR_PRIVATE_KEY" };
  if (needsAuth(op) && !op.operationId?.includes("Login")) {
    delete headers["public-key"];
    Object.assign(headers, { "public-key": "YOUR_PUBLIC_KEY", "private-key": "YOUR_PRIVATE_KEY" });
  }
  if (op.operationId === "Login" || op.operationId === "getApiInfo") {
    delete headers["public-key"];
    delete headers["private-key"];
  }

  const successEx = getResponseExample(op, "200") || {
    result: "1",
    message: "Success",
    data: {},
  };
  const errorEx = { result: "0", message: "Error description", data: { error: "details" } };
  const useCases = op["x-useCases"] || [];
  const errorRefs = op["x-errors"] || [];
  const rateLine = formatRateLimitLine(op);
  const rl = op["x-rateLimit"];
  const rateNotes = typeof rl === "object" ? rl.notes : "";

  return `
    <article class="endpoint-header">
      <p class="tag-line">${esc(item.tag)}</p>
      <h1>${esc(op.summary || path)}</h1>
      <p class="lead-muted">${esc(op.description || "")}</p>

      <div class="endpoint-url">
        <span class="method-badge method-${method}">${method}</span>
        <code class="endpoint-path">${esc(path)}</code>
      </div>

      <div class="meta-pills">
        <span class="pill">Rate limit: ${esc(rateLine)}</span>
        ${needsAuth(op) ? `<span class="pill pill-auth">Requires API keys</span>` : `<span class="pill">No auth</span>`}
      </div>
      ${rateNotes ? `<p class="muted small">${esc(rateNotes)}</p>` : ""}

      <div class="url-box card" style="margin:16px 0">
        <label>Production URL</label>
        <code>${esc(fullUrl)}</code>
      </div>

      ${
        useCases.length
          ? `<div class="section"><h2>Use cases</h2><ul>${useCases.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></div>`
          : ""
      }

      <div class="section">
        <h2>Request</h2>
        <h3>Headers</h3>
        ${renderParamTable(
          params.filter((p) => p.in === "header").length
            ? params.filter((p) => p.in === "header")
            : needsAuth(op)
              ? [
                  { name: "public-key", in: "header", required: true, schema: { type: "string" }, description: "API public key" },
                  { name: "private-key", in: "header", required: true, schema: { type: "string" }, description: "API private key" },
                  { name: "Content-Type", in: "header", required: method !== "GET", schema: { type: "string" }, description: "application/json for POST bodies" },
                ]
              : [{ name: "Content-Type", in: "header", required: false, schema: { type: "string" }, description: "application/json when sending body" }]
        )}
        <h3>Path &amp; query</h3>
        ${renderParamTable(params.filter((p) => p.in === "path" || p.in === "query"))}
        ${
          bodyExample
            ? `<h3>Body example</h3>${renderCodeTabs(
                buildCurl(method, fullUrl, headers, bodyExample),
                buildNode(method, fullUrl, headers, bodyExample),
                buildPython(method, fullUrl, headers, bodyExample)
              )}`
            : ""
        }
      </div>

      <div class="section">
        <h2>Responses</h2>
        <h3><span class="status-pill status-2xx">result: 1</span> Success</h3>
        <div class="code-block-wrap"><pre><code>${esc(JSON.stringify(successEx, null, 2))}</code></pre></div>
        <h3><span class="status-pill status-4xx">result: 0</span> Failure</h3>
        <div class="code-block-wrap"><pre><code>${esc(JSON.stringify(errorEx, null, 2))}</code></pre></div>
        ${
          errorRefs.length
            ? `<p>Common errors: ${errorRefs.map((c) => `<a href="#/errors">${esc(c)}</a>`).join(", ")}</p>`
            : ""
        }
      </div>

      <p style="margin-top:24px"><a href="#/execute?op=${encodeURIComponent(item.id)}" class="btn-primary inline-btn">Test this API →</a></p>
    </article>`;
}

function renderTester(preselectId) {
  const opts = operations
    .map((o) => `<option value="${o.id}" ${o.id === preselectId ? "selected" : ""}>${o.method} ${o.path} — ${esc(o.summary)}</option>`)
    .join("");

  return `
    <div class="tester-layout">
      <h1 class="page-title">API Tester</h1>
      <p class="page-lead">Live requests go through this portal's proxy to <code>${PRODUCTION_BASE}</code>. Connect API keys in the header — they are sent as <code>public-key</code> and <code>private-key</code> on every call.</p>

      <div class="tester-grid">
        <div class="card tester-form" id="testerForm">
          <label>API endpoint</label>
          <select id="testerOp">${opts}</select>
          <div id="testerParams"></div>
          <label>Request body (JSON)</label>
          <textarea id="testerBody" rows="12" placeholder="{}"></textarea>
          <div class="tester-actions">
            <button type="button" class="btn-primary" id="testerRun">Execute API</button>
            <button type="button" class="btn-secondary" id="testerCurl">Copy cURL</button>
            <button type="button" class="btn-secondary" id="testerRateBtn">Check rate limit</button>
          </div>
          <p class="muted small" id="testerAuthHint"></p>
          <div class="rate-live-values small" id="testerRateLive">Rate limit: click Execute or Check rate limit</div>
        </div>
        <div class="card">
          <h3 class="tester-response-title">Response</h3>
          <div class="response-meta" id="testerMeta">Select an API and click Execute.</div>
          <div class="response-box"><pre id="testerOut">{}</pre></div>
        </div>
      </div>
    </div>`;
}

function bindTester(preselectId) {
  const opSelect = $("#testerOp");
  const paramsDiv = $("#testerParams");
  const bodyTa = $("#testerBody");
  const hint = $("#testerAuthHint");

  function currentOp() {
    return operations.find((o) => o.id === opSelect.value);
  }

  function fillForm() {
    const item = currentOp();
    if (!item) return;
    paramsDiv.innerHTML = "";
    collectParams(item.op, item.path)
      .filter((p) => p.in === "path" || p.in === "query")
      .forEach((p) => {
        const lab = document.createElement("label");
        lab.textContent = `${p.name} (${p.in})${p.required ? " *" : ""}`;
        const inp = document.createElement("input");
        inp.dataset.param = p.name;
        inp.dataset.in = p.in;
        inp.placeholder = p.schema?.example || p.name;
        if (p.name === "awb_number") inp.value = "";
        if (p.name === "order_id") inp.value = "test123";
        paramsDiv.appendChild(lab);
        paramsDiv.appendChild(inp);
      });
    const ex = getRequestExample(item.op);
    bodyTa.value = ex ? JSON.stringify(ex, null, 2) : "";
    const hideBody = item.method === "GET";
    bodyTa.classList.toggle("hidden", hideBody);
    const bodyLabel = bodyTa.previousElementSibling;
    if (bodyLabel?.tagName === "LABEL") bodyLabel.classList.toggle("hidden", hideBody);

    const authRequired = needsAuth(item.op);
    const creds = getActiveCredentials();
    if (authRequired && !creds.publicKey) {
      hint.className = "hint-warn";
      hint.textContent = "Connect API keys (header button) or paste keys and click Save.";
    } else if (authRequired) {
      hint.className = "hint-ok";
      hint.textContent = "API keys will be sent as public-key and private-key headers.";
    } else {
      hint.className = "hint-ok";
      hint.textContent = "No API keys required for this endpoint.";
    }
  }

  opSelect.addEventListener("change", fillForm);
  fillForm();
  if (preselectId) opSelect.value = preselectId;

  function buildPathAndQuery() {
    const item = currentOp();
    let path = item.path;
    const qs = [];
    paramsDiv.querySelectorAll("input[data-param]").forEach((inp) => {
      if (inp.dataset.in === "path" && inp.value) path = path.replace(`{${inp.dataset.param}}`, encodeURIComponent(inp.value));
      if (inp.dataset.in === "query" && inp.value) qs.push(`${inp.dataset.param}=${encodeURIComponent(inp.value)}`);
    });
    if (qs.length) path += "?" + qs.join("&");
    return { item, path };
  }

  $("#testerRun").addEventListener("click", async () => {
    const { item, path } = buildPathAndQuery();
    const headers = { ...authHeaders() };
    let body;
    if (!["GET"].includes(item.method)) {
      try {
        body = bodyTa.value.trim() ? JSON.parse(bodyTa.value) : undefined;
      } catch {
        $("#testerOut").textContent = "Invalid JSON in request body";
        return;
      }
    }
    if (needsAuth(item.op) && !headers["public-key"]) {
      $("#testerMeta").textContent = "Missing credentials";
      $("#testerOut").textContent = 'Click "Connect API" in the header, paste keys, and Save.';
      $("#testerOut").parentElement?.classList.add("error");
      return;
    }
    $("#testerMeta").textContent = "Loading…";
    $("#testerOut").parentElement?.classList.remove("error");
    const runBtn = $("#testerRun");
    runBtn.disabled = true;
    try {
      const wrapped = await proxyRequest({
        method: item.method,
        path,
        headers,
        body,
      });
      let meta = `${wrapped.status} ${wrapped.statusText || ""} · ${wrapped.url || path}`.trim();
      if (wrapped.rateLimit?.limit) {
        meta += ` · Rate limit: ${wrapped.rateLimit.remaining ?? "?"}/${wrapped.rateLimit.limit} @ ${wrapped.rateLimit.observedAt || ""}`;
        const rlEl = $("#testerRateLive");
        if (rlEl) {
          rlEl.innerHTML = `Live headers: <strong>${esc(String(wrapped.rateLimit.remaining))}</strong> / ${esc(String(wrapped.rateLimit.limit))} remaining (this request)`;
        }
      }
      $("#testerMeta").textContent = meta;
      if (wrapped.error === "UPSTREAM_HTML") {
        $("#testerOut").parentElement?.classList.add("error");
        $("#testerOut").textContent = wrapped.message;
      } else {
        const payload = wrapped.data;
        const interpretation = interpretShipmozoResponse(payload);
        const pre = $("#testerOut");
        const bannerId = "testerResultBanner";
        let banner = document.getElementById(bannerId);
        if (interpretation) {
          if (!banner && pre?.parentElement) {
            banner = document.createElement("div");
            banner.id = bannerId;
            pre.parentElement.insertBefore(banner, pre);
          }
          if (banner) {
            banner.className = `result-banner ${interpretation.type}`;
            banner.innerHTML = `<strong>${esc(interpretation.title)}</strong><p>${esc(interpretation.text)}</p>`;
          }
          if (interpretation.type === "pending") syncAuthUI("pending");
        } else if (banner) {
          banner.remove();
        }
        const display = {
          rateLimit: wrapped.rateLimit,
          rateLimitHeaders: wrapped.rateLimitHeaders,
          shipmozo: payload,
        };
        pre.textContent = JSON.stringify(display, null, 2);
      }
    } catch (e) {
      $("#testerMeta").textContent = "Request failed";
      $("#testerOut").parentElement?.classList.add("error");
      $("#testerOut").textContent = String(e.message);
    } finally {
      runBtn.disabled = false;
    }
  });

  $("#testerRateBtn")?.addEventListener("click", async () => {
    const rlEl = $("#testerRateLive");
    if (rlEl) rlEl.textContent = "Checking…";
    try {
      const live = await fetchLiveRateLimit();
      const rl = live.rateLimit;
      if (rlEl && rl?.limit) {
        rlEl.innerHTML = `Live headers: <strong>${esc(String(rl.remaining))}</strong> / ${esc(String(rl.limit))} via <code>${esc(live.via)}</code> @ ${esc(rl.observedAt || "")}`;
      }
    } catch (e) {
      if (rlEl) rlEl.textContent = e.message;
    }
  });

  $("#testerCurl").addEventListener("click", () => {
    const { item, path } = buildPathAndQuery();
    const url = PRODUCTION_BASE + path;
    const headers = { ...authHeaders() };
    let body;
    try {
      body = bodyTa.value.trim() ? JSON.parse(bodyTa.value) : undefined;
    } catch {
      return;
    }
    navigator.clipboard.writeText(buildCurl(item.method, url, headers, body));
    $("#testerCurl").textContent = "Copied!";
    setTimeout(() => ($("#testerCurl").textContent = "Copy cURL"), 1500);
  });
}

function buildSidebar(filter = "") {
  const nav = $("#sidebarNav");
  const q = filter.toLowerCase();
  const staticGroups = [
    {
      title: "Getting started",
      links: [
        { href: "#/", label: "Overview" },
        { href: "#/auth", label: "Authentication" },
        { href: "#/workflows", label: "Integration flows" },
        { href: "#/rate-limits", label: "Rate limits" },
        { href: "#/errors", label: "Error codes" },
        { href: "#/best-practices", label: "Best practices" },
      ],
    },
  ];

  const byTag = {};
  operations.forEach((o) => {
    if (q && !`${o.method} ${o.path} ${o.summary}`.toLowerCase().includes(q)) return;
    if (!byTag[o.tag]) byTag[o.tag] = [];
    byTag[o.tag].push(o);
  });

  let html = "";
  staticGroups.forEach((g) => {
    html += `<div class="nav-group"><div class="nav-group-title">${g.title}</div>`;
    g.links.forEach((l) => {
      html += `<a class="nav-link" href="${l.href}">${esc(l.label)}</a>`;
    });
    html += `</div>`;
  });

  html += `<div class="nav-group"><div class="nav-group-title">Tools</div><a class="nav-link" href="#/execute">API Tester</a></div>`;

  const tagOrder = ["Common", "Utility", "Orders", "Warehouse", "Track", "Label"];
  const tags = [...new Set([...tagOrder, ...Object.keys(byTag)])];
  tags.forEach((tag) => {
    if (!byTag[tag]?.length) return;
    html += `<div class="nav-group"><div class="nav-group-title">${esc(tag)}</div>`;
    byTag[tag].forEach((o) => {
      html += `<a class="nav-link" href="#/api/${o.id}"><span class="method method-${o.method}">${o.method}</span>${esc(o.summary)}</a>`;
    });
    html += `</div>`;
  });

  nav.innerHTML = html;
}

function setActiveNav() {
  const hash = location.hash || "#/";
  document.querySelectorAll(".nav-link").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("href") === hash.split("?")[0]);
  });
  document.querySelectorAll(".topnav-link").forEach((a) => {
    const nav = a.dataset.nav;
    const h = hash.split("?")[0];
    a.classList.toggle(
      "active",
      (nav === "execute" && h.startsWith("#/execute")) ||
        (nav === "workflows" && h === "#/workflows") ||
        (nav === "errors" && (h === "#/errors" || h === "#/rate-limits")) ||
        (nav === "docs" && !["#/execute", "#/workflows", "#/errors", "#/rate-limits"].some((x) => h.startsWith(x)))
    );
  });
}

async function route() {
  const main = $("#main");
  const hash = location.hash || "#/";
  setActiveNav();

  if (hash.startsWith("#/execute")) {
    const op = new URLSearchParams(hash.split("?")[1] || "").get("op");
    main.innerHTML = renderTester(op);
    bindTester(op);
    return;
  }
  if (hash === "#/" || hash === "#") {
    main.innerHTML = renderStaticIntro();
    bindCodeTabs(main);
    $("#heroConnectBtn")?.addEventListener("click", openAuthDialog);
    return;
  }
  if (hash === "#/auth") {
    main.innerHTML = renderAuthPage();
    bindCodeTabs(main);
    return;
  }
  if (hash === "#/workflows") {
    main.innerHTML = renderWorkflows();
    return;
  }
  if (hash === "#/rate-limits") {
    main.innerHTML = renderRateLimitsPage();
    bindLiveRateLimit(main);
    return;
  }
  if (hash === "#/errors") {
    main.innerHTML = renderErrors();
    return;
  }
  if (hash === "#/best-practices") {
    main.innerHTML = renderBestPractices();
    return;
  }

  const apiMatch = hash.match(/^#\/api\/(.+)$/);
  if (apiMatch) {
    const item = operations.find((o) => o.id === apiMatch[1]);
    if (item) {
      main.innerHTML = renderEndpoint(item);
      bindCodeTabs(main);
      return;
    }
  }

  main.innerHTML = renderStaticIntro();
  bindCodeTabs(main);
}

function openAuthDialog() {
  const dlg = $("#authDialog");
  if (dlg?.showModal) dlg.showModal();
}

function bindAuthDialog() {
  $("#openAuthBtn")?.addEventListener("click", openAuthDialog);
  $("#closeAuthBtn")?.addEventListener("click", () => $("#authDialog")?.close());

  $("#authLoginBtn")?.addEventListener("click", async () => {
    const u = $("#authUsername").value.trim();
    const p = $("#authPassword").value;
    const msg = $("#authLoginMsg");
    if (!u || !p) {
      msg.className = "auth-login-msg error";
      msg.textContent = "Enter username and password.";
      return;
    }
    $("#authLoginBtn").disabled = true;
    msg.textContent = "Signing in…";
    msg.className = "auth-login-msg";
    try {
      await loginWithPassword(u, p);
      msg.className = "auth-login-msg ok";
      msg.textContent = "Keys saved. You can close this dialog.";
      toast("API keys connected", "ok");
      $("#authDialog")?.close();
    } catch (e) {
      msg.className = "auth-login-msg error";
      msg.textContent = e.message;
    } finally {
      $("#authLoginBtn").disabled = false;
    }
  });

  $("#authSaveKeysBtn")?.addEventListener("click", async () => {
    const c = getActiveCredentials();
    const msg = $("#authLoginMsg");
    if (!c.publicKey || !c.privateKey) {
      toast("Enter both public-key and private-key", "error");
      return;
    }
    credentials.publicKey = c.publicKey;
    credentials.privateKey = c.privateKey;
    saveCredentials();
    msg.className = "auth-login-msg";
    msg.textContent = "Checking account with Shipmozo…";
    const accountState = await probeAccountStatus();
    syncAuthUI(accountState === "verified" ? "verified" : accountState === "pending" ? "pending" : undefined);
    if (accountState === "pending") {
      msg.className = "auth-login-msg error";
      msg.textContent =
        "Keys are saved and valid, but your Shipmozo profile is still under verification. Complete KYC in the panel — APIs will return result 0 until approved.";
      toast("Keys saved — account pending verification", "error");
    } else if (accountState === "verified") {
      msg.className = "auth-login-msg ok";
      msg.textContent = "Keys saved. Account is active.";
      toast("Keys saved — account ready", "ok");
      $("#authDialog")?.close();
    } else {
      msg.className = "auth-login-msg ok";
      msg.textContent = "Keys saved locally.";
      toast("API keys saved", "ok");
      $("#authDialog")?.close();
    }
  });

  $("#authClearBtn")?.addEventListener("click", () => {
    clearCredentials();
    $("#authUsername").value = "";
    $("#authPassword").value = "";
    $("#authLoginMsg").textContent = "";
    toast("Disconnected", "info");
  });
}

async function checkProxyAvailable() {
  try {
    const { data } = await fetchJson("/health");
    return data?.proxy === true;
  } catch {
    return false;
  }
}

function showProxyWarning() {
  const main = $("#main");
  if (!main || document.getElementById("proxyWarn")) return;
  const banner = document.createElement("div");
  banner.id = "proxyWarn";
  banner.className = "note warn";
  banner.style.marginBottom = "20px";
  banner.innerHTML = `<strong>API Tester offline.</strong> Docs work, but live API calls need the Node server. In terminal: <code>cd logistics-api</code> then <code>npm start</code> (stop Live Server / other app on port 3000 first).`;
  main.prepend(banner);
}

async function init() {
  loadCredentials();
  bindAuthDialog();
  try {
    await loadSpec();
    $("#loading")?.remove();
    buildSidebar();
    $("#searchInput").addEventListener("input", (e) => buildSidebar(e.target.value));
    window.addEventListener("hashchange", route);
    route();
    const proxyOk = await checkProxyAvailable();
    if (!proxyOk) showProxyWarning();
  } catch (e) {
    $("#main").innerHTML = `<p class="error-text">Failed to load API spec: ${esc(e.message)}</p>
      <p class="muted" style="padding:0 24px">Run <code>npm run build:spec</code> then <code>npm start</code> from the logistics-api folder. Hard-refresh (Ctrl+Shift+R).</p>`;
  }
}

init();
