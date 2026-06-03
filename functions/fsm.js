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

  let cloudId = null;
  let objectType = null;

  // Only POST carries a body; GET just falls through to the redirect.
  if (request.method === "POST") {
    try {
      const contentType = request.headers.get("content-type") || "";

      if (contentType.includes("application/x-www-form-urlencoded") ||
          contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        cloudId = form.get("cloudId");
        objectType = form.get("objectType");
        const userName = form.get("userName");
        if (userName && !out.has("userName")) out.set("userName", userName);
      } else if (contentType.includes("application/json")) {
        const body = await request.json();
        cloudId = body.cloudId || (body.data && body.data.cloudId) || null;
        objectType = body.objectType || null;
        if (body.userName && !out.has("userName")) out.set("userName", body.userName);
      } else {
        // Unknown content type — try formData, then raw urlencoded text.
        try {
          const form = await request.formData();
          cloudId = form.get("cloudId");
          objectType = form.get("objectType");
          const userName = form.get("userName");
          if (userName && !out.has("userName")) out.set("userName", userName);
        } catch (e) {
          const text = await request.text();
          const parsed = new URLSearchParams(text);
          cloudId = parsed.get("cloudId");
          objectType = parsed.get("objectType");
          const userName = parsed.get("userName");
          if (userName && !out.has("userName")) out.set("userName", userName);
        }
      }
    } catch (err) {
      // Body parse failed — redirect without objectId so the app still loads
      // (it shows the manual-entry panel rather than erroring).
    }
  }

  if (cloudId) {
    out.set("objectId", cloudId);
    if (objectType) out.set("objectType", objectType);
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
