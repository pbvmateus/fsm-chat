/**
 * Cloudflare Pages Function — FSM mobile context bridge.
 *
 * PROBLEM THIS SOLVES
 * The FSM mobile Web Container opens the extension with an HTTP POST whose
 * form body carries the context, including the selected activity id in the
 * field `cloudId` (with `objectType=ACTIVITY`). A static host (GitHub Pages,
 * or Cloudflare Pages serving only static assets) cannot read a POST body, and
 * GitHub Pages rejects POST outright with 405. Client-side JS also cannot read
 * the body of the POST that loaded the page.
 *
 * WHAT THIS DOES
 * This function runs server-side at the /index.html path. It accepts the POST,
 * reads `cloudId` from the form body, and 303-redirects the browser to the
 * static app with the activity id placed in the QUERY STRING as `objectId`,
 * plus role/client. The SAPUI5 app already reads `objectId` from the URL and
 * auto-binds the chat room to it (same code path the shell uses). So after the
 * redirect, the mobile side opens directly into the correct activity's chat.
 *
 * GET requests (e.g. opening the URL in a browser) pass straight through to the
 * static asset, unchanged.
 *
 * ROUTING
 * `functions/index.html.js` maps to the path `/index.html`. `_routes.json`
 * (in the project root) includes `/index.html` so this function is invoked
 * there, while all other paths are served as static assets.
 *
 * SECURITY NOTE (read before any non-test use)
 * The POST body also contains an `authToken` (a JWT) and `authenticationKey`.
 * This function does NOT validate them — it is a TEST bridge. For real use you
 * must verify the token (issuer/signature/expiry) before trusting the request,
 * otherwise this endpoint is an open redirect that anyone can POST to. Treat
 * this as a demo until that validation is added.
 */

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);

  // Only intercept POSTs (the FSM container). Everything else -> static asset.
  if (request.method !== "POST") {
    return next();
  }

  // Default passthrough query params; we will add objectId once we find it.
  // Preserve any query params already on the URL (role/client/debug may be
  // configured in the FSM container URL).
  const out = new URLSearchParams(url.search);

  // Sensible defaults for the mobile case if not already provided.
  if (!out.has("role")) out.set("role", "technician");
  if (!out.has("client")) out.set("client", "MOBILE");

  let cloudId = null;
  let objectType = null;

  try {
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/x-www-form-urlencoded") ||
        contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      cloudId = form.get("cloudId");
      objectType = form.get("objectType");
      // Carry through a couple of useful identity fields if present, so the
      // app can show the real user without needing the Shell SDK on mobile.
      const userName = form.get("userName");
      if (userName && !out.has("userName")) out.set("userName", userName);
    } else if (contentType.includes("application/json")) {
      const body = await request.json();
      cloudId = body.cloudId || (body.data && body.data.cloudId) || null;
      objectType = body.objectType || null;
      if (body.userName && !out.has("userName")) out.set("userName", body.userName);
    } else {
      // Unknown content type: try formData first, then raw text parse.
      try {
        const form = await request.formData();
        cloudId = form.get("cloudId");
        objectType = form.get("objectType");
      } catch (e) {
        const text = await request.text();
        const parsed = new URLSearchParams(text);
        cloudId = parsed.get("cloudId");
        objectType = parsed.get("objectType");
      }
    }
  } catch (err) {
    // If body parsing fails, fall through to a redirect WITHOUT objectId so the
    // app still loads (it will show the manual-entry panel rather than error).
  }

  // Only bind automatically when this is an ACTIVITY context and we have an id.
  // (objectType may be absent in some payloads; if cloudId is present we still
  // use it, since cloudId == activity id for this container.)
  if (cloudId) {
    out.set("objectId", cloudId);
    if (objectType) out.set("objectType", objectType);
  }

  // Redirect (303 See Other) to the static app via GET, so the browser fetches
  // index.html normally and the SPA boots with objectId in the URL.
  const target = url.origin + "/index.html?" + out.toString();

  return new Response(null, {
    status: 303,
    headers: {
      "Location": target,
      "Cache-Control": "no-store"
    }
  });
}
