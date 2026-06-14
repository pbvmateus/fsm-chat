/**
 * Cloudflare Pages Function — FSM mobile Direct Chat entry point.
 * Path: /mobile  (functions/mobile.js → /mobile route)
 *
 * This is the entry point for the standalone "Dispatcher Channel" Web Container
 * registered in FSM mobile WITHOUT an activity context. The technician opens it
 * from the FSM menu/home screen.
 *
 * FSM POSTs user context (userName, userId, authToken etc.) even for non-activity
 * containers. We extract the identity fields and redirect to /index.html with
 * role=technician, screen=direct, and the user identity in the query string.
 * The app detects screen=direct and navigates immediately to the DirectChat view.
 *
 * No cloudId / objectId needed — this channel is not activity-scoped.
 */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  const out = new URLSearchParams(url.search);
  out.set("role", "technician");
  out.set("client", "MOBILE");
  out.set("screen", "direct");  // signals the app to open DirectChat immediately

  let userId = null;
  let userName = null;

  // Diagnostic mode: add &diag=1 to see exactly what FSM sent.
  const diag = url.searchParams.get("diag") === "1";

  let rawBody = "";
  let parsedKind = "none";

  try {
    if (request.method === "POST") {
      rawBody = await request.text();
      const trimmed = (rawBody || "").trim();
      const looksJson = trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[";

      if (looksJson) {
        parsedKind = "json (sniffed)";
        try {
          const body = JSON.parse(trimmed);
          userId = body.userId ? String(body.userId) : null;
          userName = body.userName || null;
        } catch (e) { /* leave nulls */ }
      } else {
        parsedKind = "form/urlencoded (sniffed)";
        const parsed = new URLSearchParams(rawBody);
        userId = parsed.get("userId");
        userName = parsed.get("userName");
        // Nested data= fallback
        if (!userId && parsed.get("data")) {
          try {
            const inner = JSON.parse(parsed.get("data"));
            userId = inner.userId ? String(inner.userId) : null;
            userName = inner.userName || null;
          } catch (e) { /* leave nulls */ }
        }
      }
    }
  } catch (err) {
    rawBody = "(error reading body: " + (err && err.message) + ")";
  }

  if (diag) {
    const esc = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html =
      "<!DOCTYPE html><html><head><meta charset='utf-8'>" +
      "<meta name='viewport' content='width=device-width, initial-scale=1'>" +
      "<title>FSM /mobile diagnostic</title>" +
      "<style>body{font-family:-apple-system,Segoe UI,sans-serif;margin:0;padding:14px;background:#f5f6f7}" +
      ".box{background:#fff;border:1px solid #ddd;border-radius:8px;padding:10px;margin-bottom:12px}" +
      ".big{font-size:15px;padding:8px;border-radius:6px;margin-bottom:6px}" +
      ".g{background:#c8e6c9;color:#1b5e20}.r{background:#ffcdd2;color:#b71c1c}" +
      "pre{white-space:pre-wrap;word-break:break-all;font-size:12px;background:#1e1e1e;color:#d4d4d4;padding:10px;border-radius:6px}</style>" +
      "</head><body>" +
      "<h1 style='font-size:17px;margin:0 0 10px'>FSM /mobile diagnostic</h1>" +
      "<div class='big " + (request.method === "POST" ? "g" : "r") + "'>METHOD: " + esc(request.method) + "</div>" +
      "<div class='big " + (userId ? "g" : "r") + "'>userId: " + esc(userId || "(MISSING)") + "</div>" +
      "<div class='box'><b>userName</b>: " + esc(userName) + "</div>" +
      "<div class='box'><b>parsed as</b>: " + esc(parsedKind) + "</div>" +
      "<div class='box'><b>Request body (raw)</b><pre>" + esc((rawBody || "(empty)").slice(0, 4000)) + "</pre></div>" +
      "</body></html>";
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
    });
  }

  if (userId) out.set("userId", userId);
  if (userName) out.set("userName", userName);

  const target = url.origin + "/index.html?" + out.toString();
  return new Response(null, {
    status: 303,
    headers: { "Location": target, "Cache-Control": "no-store" }
  });
}
