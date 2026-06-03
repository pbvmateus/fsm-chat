# FSM Chat — SAP Fiori extension

A small **SAPUI5 / Fiori** application that provides a **real-time chat channel**
between:

- a **Technician** using the **SAP FSM mobile app**, and
- a **Dispatcher** using the **SAP FSM shell (web) app**.

Both clients open the chat from the same FSM object (a Service Call / Activity).
Because the conversation is keyed by that object id, both sides land in the
**same chat thread** automatically.

> This is a **test / demo** build: no database, no authentication. It is meant
> to be deployed quickly (e.g. GitHub Pages) and registered as an FSM extension
> so you can try the end-to-end flow.

---

## What you get

| Feature | Notes |
|---|---|
| Chat channel | Text messages, newest at the bottom, auto-scroll |
| Real-time delivery | Via a WebSocket relay (optional server included) |
| No-backend mode | Falls back to `BroadcastChannel` so two browser tabs on the same machine can chat with **zero** backend |
| Presence + typing | "Online / Offline" badge and a "… is typing" indicator |
| Role awareness | Technician vs Dispatcher resolved from FSM launch parameters |
| FSM client awareness | Detects MOBILE vs SHELL, adapts identity/labels |
| Fiori look & feel | Built on `sap.m`, `sap_horizon` theme, renders correctly inside FSM |

---

## Project layout

```
fsm-chat/
├─ webapp/                     ← the deployable Fiori app (this is what FSM loads)
│  ├─ Component.js             ← bootstraps app, resolves FSM user/role/object context
│  ├─ manifest.json            ← UI5 app descriptor (+ sap.fsm extension block)
│  ├─ index.html               ← standalone entry (GitHub Pages / FSM)
│  ├─ flpSandbox.html          ← Fiori Launchpad sandbox for local testing
│  ├─ controller/              ← App + Main controllers (chat logic)
│  ├─ view/                    ← App + Main XML views (UI)
│  ├─ model/ChatTransport.js   ← pluggable transport (WebSocket | BroadcastChannel)
│  ├─ css/style.css            ← chat bubble styling
│  └─ i18n/i18n.properties     ← texts
├─ server/ws-server.js         ← OPTIONAL real-time relay (Node + ws)
├─ fsm-extension.json          ← descriptor documenting how to register in FSM
├─ .github/workflows/deploy.yml← auto-deploy webapp to GitHub Pages
├─ ui5.yaml / package.json     ← UI5 tooling (optional local dev)
└─ README.md
```

---

## 1) Run it locally (fastest)

No tooling needed — it loads UI5 from the public CDN.

```bash
# from the repo root
cd webapp
python3 -m http.server 8080      # or: npx serve .
```

Open **two** windows to simulate both sides (no backend required — they talk
over BroadcastChannel on the same machine, keyed by the same objectId):

- Technician: `http://localhost:8080/index.html?role=technician&objectId=SC123&userName=Alice`
- Dispatcher: `http://localhost:8080/index.html?role=dispatcher&objectId=SC123&userName=Bob`

Type in one window → it appears in the other.

> Same-machine only. For true cross-device chat, use the WebSocket relay below.

### Optional: real-time relay (cross-device)

```bash
npm install            # installs ws
npm run ws             # starts relay on :8088
```

Then add `&ws=ws://localhost:8088` to both URLs above. Now a phone and a laptop
on the same network (point them at your machine's IP, use `wss://` if served
over TLS) share the conversation in real time.

---

## 2) Deploy to GitHub (for testing)

1. Create a new GitHub repo and push this project.
   ```bash
   git init
   git add .
   git commit -m "FSM Chat extension"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```
2. In the repo: **Settings → Pages → Build and deployment → Source = GitHub Actions**.
3. The included workflow (`.github/workflows/deploy.yml`) publishes the
   `webapp/` folder. After it runs, your app is live at:
   ```
   https://<you>.github.io/<repo>/
   ```
4. Test it the same way as local:
   `https://<you>.github.io/<repo>/index.html?role=technician&objectId=SC123&userName=Alice`

> GitHub Pages serves static files only. The no-backend (BroadcastChannel) mode
> works on Pages for same-machine testing. For real-time cross-device on a
> hosted URL, deploy `server/ws-server.js` somewhere that supports WebSockets
> (Render, Railway, Fly.io, a VM, etc.) and pass `&ws=wss://your-relay`.

---

## 3) Install as an SAP FSM extension

**Important:** the shell and the mobile app use *two different mechanisms*, so
you configure this twice:

- **Dispatcher (shell)** → a custom **Extension** placed in the **Side Bar** outlet.
- **Technician (mobile)** → a **Web Container**.

### 3a) Dispatcher — Shell extension in the Side Bar

1. In the **FSM Shell**, go to **Foundational Services → Extensions → Directory**.
2. **Add a custom extension** and point it at your deployed app:
   ```
   https://<you>.github.io/<repo>/index.html?role=dispatcher&client=SHELL
   ```
   (For real-time cross-device, also append `&ws=wss://your-relay`.)
3. For the **placement / outlet**, choose the **Side Bar** (not "embed in Service
   Call screen"). The sidebar stays open across screens.
4. **Assign visibility** to your dispatcher user group and **save / publish**.

On load, the app initializes the **FSM Shell SDK** (`REQUIRE_CONTEXT`) to get the
logged-in user automatically. It then tries to read the **currently selected
Service Call** from the Shell. See the note below about why that part is
best-effort.

### 3b) Technician — Mobile Web Container

1. In **Admin**, open the **Web Containers** configuration (governs external
   pages shown inside the iOS/Android app).
2. Create a container pointing at:
   ```
   https://<you>.github.io/<repo>/index.html?role=technician&client=MOBILE
   ```
3. Surface it in the side menu (or a workflow step) and enable it for the
   technician's user. Re-sync / re-login on the device.

`fsm-extension.json` documents both configurations as a checklist.

### How a conversation gets scoped to an activity (read this)

The chat is **per Service Call**: a given Service Call ID maps to one room, and
both sides must use the same ID to talk.

- **Automatic (where supported):** in the shell sidebar, the app asks the Shell
  SDK for the selected activity and binds the chat to it automatically, updating
  when the dispatcher clicks a different Service Call.
- **The honest caveat:** SAP's documented channel for "the selected object"
  (the Shell SDK *ViewState*) is **restricted for outlet/sidebar extensions** and
  may not deliver the selection in your tenant/version. The app attempts several
  channels defensively, but **does not assume** they work.
- **Reliable fallback (always available):** if no selection arrives, the app
  shows a small panel where you **enter the Service Call ID** to open that room.
  The technician enters the **same ID**. This guarantees per-activity chat works
  today regardless of what the platform exposes. You can also skip the panel by
  passing `&objectId=SC123` in the URL.

### Notes for FSM embedding

- The app sets `frameOptions="allow"` so it can run inside the FSM iframe.
- It loads SAP's official `fsm-shell` client library (v1.20.0) from a CDN and
  talks to the Shell host via the documented `SHELL_EVENTS` API.
- Identity (`user`, `userId`) comes from the Shell SDK when present; URL params
  `userId` / `userName` override it for standalone testing.

---

## How the two sides find each other

```
Technician (MOBILE)                    Dispatcher (SHELL)
  opens Service Call SC123               opens Service Call SC123
        │                                       │
        ▼                                       ▼
  objectId = SC123                        objectId = SC123
  roomId  = fsm-room-SC123  ───────────►  roomId  = fsm-room-SC123
        │                                       │
        └──────── same room => same chat ───────┘
```

- **No backend:** `BroadcastChannel("fsmchat:fsm-room-SC123")` (same machine).
- **With relay:** both connect to the WebSocket server and join room
  `fsm-room-SC123`; the server relays each message to the other party.

---

## Limitations (by design, for a test build)

- No persistence beyond the browser (relay keeps nothing; local mode uses
  `localStorage` for the last 200 messages per room).
- No authentication / encryption on the demo relay — **do not** use it for real
  customer data.
- Real-time across devices requires hosting the WebSocket relay somewhere that
  allows WebSocket connections (GitHub Pages cannot host the relay itself).
