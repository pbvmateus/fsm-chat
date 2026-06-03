# Mobile side on Cloudflare Pages (reads FSM's POST context)

## Why this exists

The FSM **mobile Web Container** opens the extension with an HTTP **POST** whose
body carries the context. The selected activity id arrives in the form field
**`cloudId`** (alongside `objectType=ACTIVITY`).

- GitHub Pages **rejects POST** (405) and serves static files only — it cannot
  read the body. So the mobile side cannot run on GitHub Pages.
- Client-side JavaScript also cannot read the body of the POST that loaded the
  page. So even a static host that *accepts* POST wouldn't hand the activity id
  to the app.

This requires a tiny **server-side** step. The Cloudflare Pages **Function** in
`functions/index.html.js` does exactly one thing: it catches the POST, reads
`cloudId`, and redirects to the static app with the id in the URL as
`objectId`. The app already auto-binds the chat to `objectId` (same path the
shell uses), so the mobile side opens straight into the right activity's chat.

> The **shell/dispatcher** side can stay on GitHub Pages — it loads via GET and
> already works. Only the **mobile** side needs Cloudflare.

## Repo layout used by Cloudflare

```
fsm-chat/
├─ webapp/                 ← static app (this is the Pages "output directory")
│  └─ index.html, ...
├─ functions/
│  └─ index.html.js        ← runs server-side at the /index.html path
└─ _routes.json            ← makes ONLY /index.html invoke the function
```

## One-time setup

1. Go to **Cloudflare Dashboard → Workers & Pages → Create → Pages →
   Connect to Git** and pick your `fsm-chat` GitHub repo. (Your source stays in
   GitHub; Cloudflare builds from it.)
2. **Build settings:**
   - Framework preset: **None**
   - Build command: *(leave empty)* — the app is static, loaded from the UI5 CDN
   - **Build output directory: `webapp`**
3. **Important — functions must sit next to the output dir.** Cloudflare looks
   for `functions/` and `_routes.json` at the **repo root** (they are, in this
   repo). The static assets come from `webapp/`. This combination is supported:
   root-level `functions/` + a sub-folder output directory.
   - If your Cloudflare project does not pick up the function with `webapp` as
     output, use the alternative layout below.
4. Deploy. You'll get a URL like `https://fsm-chat-xxx.pages.dev`.

### If the function isn't detected with `webapp` as output

Some Pages configurations expect `functions/` to be a sibling of the served
files. If so, move the app to the repo root for the Cloudflare deployment (keep
GitHub Pages serving `webapp/` separately), or set the output directory to `.`
and add a `_routes.json` that excludes the asset paths. Tell me and I'll provide
that exact variant — it depends on how your Pages project is configured.

## Point FSM at the Cloudflare URL

In **FSM Admin → Web Containers → (your container) → Edit**, change the **URL**
to the Cloudflare one (keep the same query params):

```
https://fsm-chat-xxx.pages.dev/index.html?role=technician&client=MOBILE&debug=1
```

Save, reopen on the phone. Flow:

1. FSM POSTs context (incl. `cloudId`) to that URL.
2. The function reads `cloudId`, redirects to
   `.../index.html?role=technician&client=MOBILE&debug=1&objectId=<cloudId>`.
3. The app boots, reads `objectId`, and connects the chat to that activity.

With `&debug=1` you'll see the activity bind in the debug box. Drop `&debug=1`
once confirmed.

## Verifying the same room on both sides

The dispatcher (shell) binds to the activity's id from `SET_VIEW_STATE`; the
technician (mobile) now binds to `cloudId`. **These must be the same id for the
two to share a chat room.** Confirm by comparing the `objectId` the mobile side
lands on against the activity id the shell shows for the same activity. If they
match, both compute `fsm-room-<id>` and connect to each other (once a real-time
relay is in place — see the main README; BroadcastChannel is same-machine only).

## Security — before any non-test use

The POST body also contains an `authToken` (JWT) and `authenticationKey`. The
function does **not** validate them; it's a test bridge and currently an open
redirect. For production you must verify the token (signature/issuer/expiry)
before trusting the request. Ask and I'll add token validation.

## BTP note

If this eventually moves to **SAP BTP**: the function's *logic* (read POST body
→ extract `cloudId` → redirect) ports directly, but the *wrapper* must be
rewritten for BTP's runtime (e.g. a Cloud Foundry Node app with an app router).
Static BTP HTML5 hosting has the same POST-body limitation as GitHub Pages, so
the BTP target would need a backend (Cloud Foundry), not the HTML5 repo.
