# Cross-device messaging — the WebSocket relay (Render)

## Why this is needed

The app's default transport is **BroadcastChannel**, which only connects
tabs/apps on the **same machine**. A technician's phone and a dispatcher's
laptop are different devices, so messages never cross — even though each side
shows "online" (that status only means the local channel opened, not that it
found a peer).

To actually move a message from phone → laptop you need a server in the middle:
a **WebSocket relay**. It relays JSON messages to everyone in the same room
(`fsm-room-<activityId>`). The relay is `server/ws-server.js`.

> This relay is **server-side, long-lived** code. It cannot run on GitHub Pages
> or Cloudflare Pages Functions (those are static / short-lived). It needs a host
> that supports persistent WebSocket servers — Render, Railway, Fly.io, or a VM.
> These steps use **Render** (free tier, deploys from GitHub, WebSockets work).

## Deploy the relay on Render

**Option A — Blueprint (uses the included `render.yaml`):**
1. https://render.com → sign up / log in (free).
2. **New → Blueprint** → connect your `fsm-chat` GitHub repo.
3. Render reads `render.yaml` and creates a web service `fsm-chat-relay` from the
   `server/` folder. Click **Apply**.
4. Wait for the first deploy. You'll get a URL like
   `https://fsm-chat-relay.onrender.com`.

**Option B — manual (if Blueprint isn't picked up):**
1. **New → Web Service** → connect the repo.
2. Settings:
   - **Root Directory:** `server`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
   - Plan: Free
3. Create. Note the `https://...onrender.com` URL.

**Verify the relay is up:** open `https://fsm-chat-relay.onrender.com/health` in
a browser — it should say `ok`.

## Wire BOTH sides to the relay

The app uses the relay only when the URL has a `ws=` parameter pointing at it.
Use the **wss://** form (secure) since the apps load over https. Both sides must
use the SAME relay URL.

**Dispatcher (shell, on GitHub Pages)** — append `&ws=` to the shell extension
URL in FSM:
```
https://pbvmateus.github.io/fsm-chat/index.html?role=dispatcher&client=SHELL&ws=wss://fsm-chat-relay.onrender.com
```

**Technician (mobile, via Cloudflare /fsm)** — append `&ws=` to the web
container URL; it survives the /fsm redirect:
```
https://fsm-chat.pages.dev/fsm?role=technician&client=MOBILE&ws=wss://fsm-chat-relay.onrender.com
```
(add `&debug=1` to either while testing)

## Test

1. Open the dispatcher (shell) on an activity.
2. Open the technician (mobile) on the **same** activity.
3. Type on one side → it should appear on the other.

## Two things that must be true for messages to cross

1. **Same relay URL** on both sides (above).
2. **Same room** — both sides must compute the same `fsm-room-<id>`. The shell
   binds to the activity id from `SET_VIEW_STATE`; mobile binds to `cloudId`.
   If those differ for the same activity, they land in different rooms and won't
   connect. With `&debug=1`, compare the bound id on each side for the same
   activity. (If they differ, that's the next thing to fix — tell me the two ids.)

## Render free-tier caveat (important)

Render's free services **sleep after ~15 min of inactivity** and take ~30–60s to
wake on the next request. So the first message after idle may lag while the relay
spins up, and a connection opened during sleep may need a moment / reconnect. The
relay sends keepalive pings, but those don't prevent free-tier sleeping. For
always-on, use a paid tier or a host without cold starts. For testing, just know
the first hit after a pause is slow — it's not a bug.

## Security (test relay)

No authentication: anyone with the URL and a room id can join that room. The room
id is an FSM activity guid (hard to guess) but this is still not production-grade.
For production: validate the FSM token and restrict origins before trusting
connections.
