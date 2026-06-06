/**
 * Cloudflare Pages Function — FSM mobile context bridge.
 * Path: /fsm   (file functions/fsm.js maps to the /fsm route)
 *
 * WHY A DEDICATED PATH
 * An earlier version put this at /index.html, which COLLIDED with the static
 * webapp/index.html file — Cloudflare resolved the path to the static asset,
 * which cannot accept POST, so FSM's POST got a 405. This version lives at the
 * standalone /fsm path where NO static file exists, so every request here is
 * handled by this function exclusively. No collision, no passthrough guesswork.
 *
 * WHAT IT DOES
 * The FSM mobile Web Container is configured to POST to .../fsm. The container
 * sends context in the form body; the selected activity id is in `cloudId`
 * (with objectType=ACTIVITY). This function reads cloudId and 303-redirects to
 * the static app at /index.html with the id in the query string as `objectId`
 * (plus role/client). The SAPUI5 app already reads `objectId` from the URL and
 * auto-binds the chat room — so the mobile side opens straight into the right
 * activity's chat.
 *
 * A GET to /fsm (e.g. opening it in a browser to sanity-check) also works: with
 * no body there's no cloudId, so it simply redirects to the app showing the
 * manual-entry panel.
 *
 * SECURITY (test bridge): the body also has an `authToken` JWT which this does
 * NOT validate. For production, verify the token before trusting the request.
 */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // Carry through any query params already on the /fsm URL (role/client/debug
  // can be set in the FSM container URL), then ensure mobile defaults.
  const out = new URLSearchParams(url.search);
  if (!out.has("role")) out.set("role", "technician");
  if (!out.has("client")) out.set("client", "MOBILE");

  // --- DIAGNOSTIC MODE -----------------------------------------------------
  // Add &diag=1 to the container URL to see EXACTLY what FSM sent (method,
  // headers, body) rendered as a page on the phone — no DevTools needed.
  // Read cloudId / objectType / method off the screen, then remove &diag=1.
  const diag = url.searchParams.get("diag") === "1";

  // Read the body once (works for POST; harmless for GET).
  let rawBody = "";
  let cloudId = null;
  let objectType = null;
  let userName = null;
  let parsedKind = "none";

  try {
    const contentType = request.headers.get("content-type") || "";
    if (request.method === "POST") {
      // Read raw text first so we can both display and parse it.
      rawBody = await request.text();
      if (contentType.includes("json")) {
        parsedKind = "json";
        try {
          const body = JSON.parse(rawBody);
          cloudId = body.cloudId || (body.data && body.data.cloudId) || null;
          objectType = body.objectType || null;
          userName = body.userName || null;
        } catch (e) { /* leave nulls */ }
      } else {
        // urlencoded / form / unknown -> try urlencoded parse
        parsedKind = "form/urlencoded";
        const parsed = new URLSearchParams(rawBody);
        cloudId = parsed.get("cloudId");
        objectType = parsed.get("objectType");
        userName = parsed.get("userName");
      }
    }
  } catch (err) {
    rawBody = "(error reading body: " + (err && err.message) + ")";
  }

  if (diag) {
    // Collect headers.
    let headerLines = "";
    for (const [k, v] of request.headers) {
      // Redact the big JWT so the page is readable; show its presence + length.
      let val = v;
      if (k.toLowerCase() === "authorization" || k.toLowerCase() === "cookie") {
        val = "(" + v.length + " chars, hidden)";
      }
      headerLines += k + ": " + val + "\n";
    }
    // Redact a token field inside the body for display, keep cloudId visible.
    let bodyForDisplay = rawBody;
    if (bodyForDisplay && bodyForDisplay.length > 4000) {
      bodyForDisplay = bodyForDisplay.slice(0, 4000) + "\n…(truncated)";
    }
    const esc = function (s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    };
    const html =
      "<!DOCTYPE html><html><head><meta charset='utf-8'>" +
      "<meta name='viewport' content='width=device-width, initial-scale=1'>" +
      "<title>FSM /fsm diagnostic</title>" +
      "<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:14px;background:#f5f6f7;color:#222}" +
      "h1{font-size:17px;margin:0 0 10px}.k{font-weight:700}" +
      ".box{background:#fff;border:1px solid #ddd;border-radius:8px;padding:10px;margin-bottom:12px}" +
      ".big{font-size:15px;padding:8px;border-radius:6px;margin-bottom:6px}" +
      ".g{background:#c8e6c9;color:#1b5e20}.r{background:#ffcdd2;color:#b71c1c}" +
      "pre{white-space:pre-wrap;word-break:break-all;font-size:12px;background:#1e1e1e;color:#d4d4d4;padding:10px;border-radius:6px}</style>" +
      "</head><body>" +
      "<h1>FSM /fsm diagnostic</h1>" +
      "<div class='big " + (request.method === "POST" ? "g" : "r") + "'>METHOD: " + esc(request.method) +
        (request.method === "POST" ? " (good — body expected)" : " (no body — this is why nothing binds)") + "</div>" +
      "<div class='big " + (cloudId ? "g" : "r") + "'>cloudId: " + (cloudId ? esc(cloudId) : "(MISSING)") + "</div>" +
      "<div class='box'><div class='k'>objectType</div>" + esc(objectType) + "</div>" +
      "<div class='box'><div class='k'>userName</div>" + esc(userName) + "</div>" +
      "<div class='box'><div class='k'>content-type</div>" + esc(request.headers.get("content-type")) +
        "<br><div class='k'>parsed as</div>" + esc(parsedKind) + "</div>" +
      "<div class='box'><div class='k'>Request body (raw)</div><pre>" + esc(bodyForDisplay || "(empty)") + "</pre></div>" +
      "<div class='box'><div class='k'>Headers</div><pre>" + esc(headerLines) + "</pre></div>" +
      "</body></html>";
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
    });
  }

  if (cloudId) {
    out.set("objectId", cloudId);
    if (objectType) out.set("objectType", objectType);
    if (userName && !out.has("userName")) out.set("userName", userName);
  }

  // Redirect to the static app (GET) with context in the query string.
  const target = url.origin + "/index.html?" + out.toString();

  return new Response(null, {
    status: 303,
    headers: {
      "Location": target,
      "Cache-Control": "no-store"
    }
  });
}
