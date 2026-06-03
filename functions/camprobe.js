/**
 * Cloudflare Pages Function — camera-probe entry point.
 * Path: /camprobe  (file functions/camprobe.js maps to the /camprobe route)
 *
 * WHY THIS EXISTS
 * The FSM mobile Web Container opens its URL with an HTTP POST. A static page
 * (camera-probe.html) cannot accept POST and returns 405. This function sits at
 * /camprobe, absorbs the POST, and 303-redirects to the static probe page via a
 * normal GET — same pattern as the working /fsm bridge for the chat app.
 *
 * It carries through any query params; it does not need the body for anything
 * (the probe just tests camera access), but it parses it harmlessly so the POST
 * is fully consumed.
 */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // Preserve any existing query params.
  const out = new URLSearchParams(url.search);

  // Consume the POST body if present (so it doesn't error); we don't use it.
  if (request.method === "POST") {
    try {
      const ct = request.headers.get("content-type") || "";
      if (ct.includes("urlencoded") || ct.includes("form-data")) {
        await request.formData();
      } else {
        await request.text();
      }
    } catch (e) { /* ignore */ }
  }

  const target = url.origin + "/camera-probe.html" +
    (out.toString() ? ("?" + out.toString()) : "");

  return new Response(null, {
    status: 303,
    headers: { "Location": target, "Cache-Control": "no-store" }
  });
}
