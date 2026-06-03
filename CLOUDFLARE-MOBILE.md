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
├─ webapp/                 ← static app (Pages "output directory")
│  └─ index.html, ...
└─ functions/
   └─ fsm.js               ← runs server-side at the /fsm route (NO static file
                             competes with this path, so no collision)
```

> Earlier this function was at `/index.html`, which collided with the static
> `webapp/index.html` — Cloudflare served the static file (which can't accept
> POST) and FSM's POST got a 405. Moving it to the standalone `/fsm` path fixes
> that: `/fsm` has no static file, so the function always handles it.

## One-time setup

1. **Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git**,
   pick your `fsm-chat` repo.
2. **Build settings:**
   - Framework preset: **None**
   - Build command: *(empty)*
   - **Build output directory: `webapp`**
   - Root directory: `/`
3. Deploy. You get a URL like `https://fsm-chat-xxx.pages.dev`.

## Point FSM at the /fsm path (IMPORTANT — note the path)

In **FSM Admin → Web Containers → your container → Edit**, set the **URL** to the
**/fsm** path (not /index.html):

```
https://fsm-chat-xxx.pages.dev/fsm?role=technician&client=MOBILE&debug=1
```

Keep **Object Types = Activity**. Save.

Flow on the phone:
1. FSM POSTs context (incl. `cloudId`) to `/fsm`.
2. The function reads `cloudId`, 303-redirects to
   `/index.html?role=technician&client=MOBILE&debug=1&objectId=<cloudId>`.
3. The app boots, reads `objectId`, connects the chat to that activity.

## Sanity check before the phone

Open this GET in a browser — it should redirect and load the app (manual panel,
since a GET has no cloudId):
```
https://fsm-chat-xxx.pages.dev/fsm?role=technician&client=MOBILE&debug=1
```
If that loads, the function and static serving both work; then test on the phone.

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
