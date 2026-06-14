/**
 * WebSocket relay for FSM Chat — cross-device bridge + generic-room fallback.
 *
 * BASE BEHAVIOR
 * Relays JSON messages to everyone in the same roomId. Activity rooms are
 * "fsm-room-<activityId>"; both clients viewing the same activity meet there.
 *
 * GENERIC-ROOM FALLBACK (the "unattended message" feature)
 * Requirement: when a technician sends a message and NO dispatcher is present in
 * that activity's room, the message is ALSO delivered to a shared generic room
 * ("fsm-generic") that every dispatcher watches. A late-arriving dispatcher sees
 * what was missed (the generic room retains recent unattended messages). Any
 * dispatcher can pick up a conversation — their client then JOINS the activity
 * room, after which a dispatcher is "present" and further messages stop going to
 * the generic room. No exclusive claim: multiple dispatchers may join and reply.
 *
 * To make this work the relay tracks state (NOT stateless anymore):
 *   - per-room membership AND each socket's ROLE (technician/dispatcher/…)
 *   - a socket can be in MULTIPLE rooms (e.g. dispatcher watches fsm-generic and
 *     also joins one or more activity rooms)
 *   - an in-memory store of recent unattended messages for the generic room
 *
 * IN-MEMORY CAVEAT: the generic-room backlog and presence live in memory. If the
 * relay restarts or wakes from free-tier sleep, the backlog is LOST. Durable
 * history would need a datastore — out of scope for this test-grade build.
 *
 * Roles: clients send role on join. Dispatchers should ALSO join "fsm-generic"
 * (the client does this automatically for role=dispatcher).
 *
 * SECURITY (test relay): no auth. Anyone with the URL + room id can join.
 */

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8088;
const HOST = "0.0.0.0";

const GENERIC_ROOM = "fsm-generic";
const GENERIC_MAX = 200;            // cap retained unattended messages
const GENERIC_TTL_MS = 24 * 60 * 60 * 1000; // drop entries older than 24h

// Per-technician broadcast history — replayed when the technician connects.
// Map of userName -> [{text, senderName, senderId, ts}]
const BROADCAST_MAX_PER_USER = 100;
const broadcastHistory = new Map(); // userName -> messages[]

function storeBroadcast(targetUserName, msg) {
  if (!targetUserName) return;
  const key = targetUserName.toLowerCase();
  if (!broadcastHistory.has(key)) broadcastHistory.set(key, []);
  const arr = broadcastHistory.get(key);
  arr.push(msg);
  // Cap per-user history and drop entries older than 24h
  const cutoff = Date.now() - GENERIC_TTL_MS;
  while (arr.length > 0 && (arr.length > BROADCAST_MAX_PER_USER || arr[0].ts < cutoff)) {
    arr.shift();
  }
}

function getBroadcastHistory(userKey) {
  return broadcastHistory.get(userKey.toLowerCase()) || [];
}

// Bump this when deploying so /rooms confirms the running build is current.
const BUILD_MARKER = "presence-active-3";
// Liveness ping interval (also used by the heartbeat below).
const HEARTBEAT_MS = 10000;

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  // Diagnostic: show what the relay currently believes about room membership
  // and per-socket liveness. Use this to tell a genuinely-gone socket (should
  // be reaped) from a background socket that is still answering pings.
  if (req.url === "/rooms") {
    const now = Date.now();
    const out = { build: BUILD_MARKER, heartbeatMs: HEARTBEAT_MS,
      now: new Date(now).toISOString(), rooms: {} };
    for (const [roomId, set] of rooms) {
      out.rooms[roomId] = {
        size: set.size,
        dispatcherPresent: dispatcherPresent(roomId),
        technicianPresent: technicianPresent(roomId),
        members: Array.from(set).map(function (ws) {
          return {
            role: ws._role || null,
            userName: ws._userName || null,
            userId: ws._userId || null,
            active: ws._active !== false,
            readyState: ws.readyState,
            isAlive: ws.isAlive !== false,
            secsSinceJoin: ws._joinedAt ? Math.round((now - ws._joinedAt) / 1000) : null,
            secsSincePong: ws._lastPong ? Math.round((now - ws._lastPong) / 1000) : null
          };
        })
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out, null, 2));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("FSM Chat WS relay is running (" + BUILD_MARKER + "). Connect via WebSocket (use wss:// in browsers).");
});

const wss = new WebSocketServer({ server });

// roomId -> Set<socket>. A socket may belong to several rooms.
const rooms = new Map();
// In-memory backlog of unattended messages routed to the generic room.
// Each entry: { activityId, roomId, text, userId, userName, ts }
let genericBacklog = [];

function addToRoom(roomId, ws) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(ws);
  ws._rooms = ws._rooms || new Set();
  ws._rooms.add(roomId);
}

function removeFromAllRooms(ws) {
  if (!ws._rooms) return;
  for (const roomId of ws._rooms) {
    const set = rooms.get(roomId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) rooms.delete(roomId);
    }
  }
  ws._rooms.clear();
}

function roomSize(roomId) {
  return rooms.has(roomId) ? rooms.get(roomId).size : 0;
}

// Is at least one peer of the given role ACTIVELY in this room? "Active" means
// the socket is open AND the client reports its chat view is visible (not
// backgrounded / navigated away). A mobile webview often keeps the socket open
// in the background, so socket-open alone is NOT a reliable "in chat" signal —
// we track an explicit _active flag the client updates via 'activity' messages.
function rolePresent(roomId, role) {
  const set = rooms.get(roomId);
  if (!set) return false;
  for (const peer of set) {
    var open = (peer.readyState === peer.OPEN || peer.readyState === 1);
    if (open && peer._active !== false && peer._role === role) return true;
  }
  return false;
}

// Is at least one DISPATCHER currently present in this activity room?
function dispatcherPresent(roomId) {
  return rolePresent(roomId, "dispatcher");
}

// Is at least one TECHNICIAN currently present in this activity room?
function technicianPresent(roomId) {
  return rolePresent(roomId, "technician");
}

function broadcast(roomId, data, exclude) {
  const peers = rooms.get(roomId);
  if (!peers) return;
  const payload = JSON.stringify(data);
  for (const peer of peers) {
    if (peer !== exclude && peer.readyState === peer.OPEN) {
      peer.send(payload);
    }
  }
}

function pruneBacklog() {
  const cutoff = Date.now() - GENERIC_TTL_MS;
  genericBacklog = genericBacklog.filter(function (m) { return m.ts >= cutoff; });
  if (genericBacklog.length > GENERIC_MAX) {
    genericBacklog = genericBacklog.slice(genericBacklog.length - GENERIC_MAX);
  }
}

function activityIdFromRoom(roomId) {
  if (!roomId) return roomId;
  if (roomId.indexOf("fsm-room-") === 0) return roomId.slice("fsm-room-".length);
  if (roomId.indexOf("fsm-direct-") === 0) return "direct:" + roomId.slice("fsm-direct-".length);
  return roomId;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws._role = null;
  ws._active = true;       // chat view assumed visible until told otherwise
  ws._lastPong = Date.now();
  ws.on("pong", () => { ws.isAlive = true; ws._lastPong = Date.now(); });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    // ---- join a room -----------------------------------------------------
    if (msg.type === "join") {
      const roomId = msg.roomId || GENERIC_ROOM;
      if (msg.role) ws._role = msg.role;
      if (msg.userId) ws._userId = msg.userId;
      if (msg.userName) ws._userName = msg.userName;
      if (!ws._joinedAt) ws._joinedAt = Date.now();

      addToRoom(roomId, ws);

      // Every technician also joins two personal rooms keyed by userName
      // (lowercased for consistency). userName is stable across both the FSM
      // Person roster (where the dispatcher picks targets) and the mobile
      // context — unlike userId which is numeric on mobile but a GUID in the
      // roster. This ensures targeted broadcasts actually reach the right device.
      if (msg.userName && msg.role === "technician") {
        const uKey = msg.userName.toLowerCase();
        addToRoom("fsm-user-" + uKey, ws);
        addToRoom("fsm-direct-" + uKey, ws);
        ws._userKey = uKey;

        // Replay any broadcasts sent while this technician was offline.
        // Merge their personal history with the "all" global history,
        // deduplicate by ts, sort oldest-first, and send as a single replay.
        const personal = getBroadcastHistory(uKey);
        const global   = getBroadcastHistory("*");
        const seen = new Set();
        const merged = [...personal, ...global]
          .filter(m => { const k = m.ts + "|" + m.text; if (seen.has(k)) return false; seen.add(k); return true; })
          .sort((a, b) => (a.ts || 0) - (b.ts || 0));
        if (merged.length > 0) {
          try {
            ws.send(JSON.stringify({
              type: "broadcast-history",
              items: merged
            }));
          } catch (e) { /* noop */ }
        }
      }

      // Announce presence to existing peers (include role).
      broadcast(roomId, {
        type: "presence", roomId: roomId, userId: msg.userId,
        userName: msg.userName, role: msg.role, online: true
      }, ws);

      // Tell the newcomer how many peers are already here, and whether a
      // dispatcher / technician is among them (authoritative initial state for
      // the header presence labels on each side).
      try {
        ws.send(JSON.stringify({
          type: "presence", roomId: roomId,
          online: roomSize(roomId) > 1, peerCount: roomSize(roomId) - 1,
          dispatcherPresent: dispatcherPresent(roomId),
          technicianPresent: technicianPresent(roomId), self: true
        }));
      } catch (e) { /* noop */ }

      // Also re-broadcast authoritative role-presence to the room so existing
      // members update their label the moment a peer joins (technician sees a
      // dispatcher arrive; dispatcher sees the technician online).
      broadcast(roomId, {
        type: "presence", roomId: roomId,
        dispatcherPresent: dispatcherPresent(roomId),
        technicianPresent: technicianPresent(roomId), roomState: true
      }, ws);

      // If a dispatcher just joined the generic room, replay the backlog so
      // they see unattended messages they missed.
      if (roomId === GENERIC_ROOM && ws._role === "dispatcher") {
        pruneBacklog();
        try {
          ws.send(JSON.stringify({
            type: "generic-backlog",
            roomId: GENERIC_ROOM,
            items: genericBacklog
          }));
        } catch (e) { /* noop */ }
      }

      // If a dispatcher joined an ACTIVITY room, the conversation is now
      // attended: drop that activity's pending entries from the backlog and
      // notify generic watchers to remove it from their "unattended" list.
      if (roomId !== GENERIC_ROOM && ws._role === "dispatcher") {
        const activityId = activityIdFromRoom(roomId);
        const before = genericBacklog.length;
        genericBacklog = genericBacklog.filter(function (m) {
          return m.activityId !== activityId;
        });
        if (genericBacklog.length !== before) {
          broadcast(GENERIC_ROOM, {
            type: "generic-claimed", activityId: activityId,
            byName: ws._userName || msg.userName || "A dispatcher"
          });
        }
      }
      return;
    }

    // ---- chat-view activity (visible/hidden) ----------------------------
    // The client sends { type:'activity', active:true|false } from the Page
    // Visibility API so presence reflects whether the chat is actually in front
    // of the user, not merely whether the socket is open in the background.
    if (msg.type === "activity") {
      ws._active = msg.active !== false;
      // Refresh presence in every room this socket belongs to so the other
      // side's "in chat" indicator updates right away.
      if (ws._rooms) {
        for (const roomId of ws._rooms) {
          if (roomId === GENERIC_ROOM) continue;
          broadcast(roomId, {
            type: "presence", roomId: roomId, roomState: true,
            dispatcherPresent: dispatcherPresent(roomId),
            technicianPresent: technicianPresent(roomId)
          }, ws);
        }
      }
      return;
    }

    // ---- direct chat (technician ↔ dispatchers, no activity needed) -----
    // Technician sends to their own fsm-direct-<userId> room. Any dispatcher
    // who has joined that room receives it. If no dispatcher is present, the
    // message is copied to fsm-generic so dispatchers see it in their inbox.
    // Dispatchers can also send direct-chat to fsm-direct-<userId> to reply.
    if (msg.type === "direct-chat") {
      const directRoom = msg.roomId || (ws._userKey ? "fsm-direct-" + ws._userKey : null);
      if (!directRoom) { return; }
      const payload = Object.assign({}, msg, {
        type: "direct-chat",
        roomId: directRoom,
        userId: ws._userId,
        userName: ws._userName || msg.userName,
        role: ws._role,
        ts: msg.ts || Date.now()
      });
      // Make sure sender is in the direct room.
      if (!ws._rooms || !ws._rooms.has(directRoom)) { addToRoom(directRoom, ws); }
      // Deliver to everyone else in the direct room.
      broadcast(directRoom, payload, ws);
      // If technician sent this and no dispatcher is in the room → notify generic.
      if (ws._role === "technician" && !dispatcherPresent(directRoom)) {
        const techUserKey = directRoom.replace("fsm-direct-", "");
        const entry = {
          activityId: "direct:" + techUserKey,
          roomId: directRoom,
          text: msg.text,
          userId: ws._userId,
          userName: ws._userName || msg.userName,
          ts: Date.now(),
          isDirect: true
        };
        genericBacklog.push(entry);
        pruneBacklog();
        broadcast(GENERIC_ROOM, {
          type: "generic-message",
          activityId: "direct:" + techUserKey,
          roomId: directRoom,
          text: msg.text,
          userId: ws._userId,
          userName: ws._userName || msg.userName,
          ts: entry.ts,
          isDirect: true
        });
      }
      return;
    }

    // ---- broadcast message (dispatcher → one/many/all technicians) -------
    // { type:'broadcast-message', text, targets:['all'|userName.toLowerCase(),...],
    //   senderName, senderId, ts }
    // Delivers to each technician's fsm-user-<userName> room. Rooms are keyed
    // by userName (lowercased) which is consistent across the FSM roster and
    // the mobile context (unlike userId which differs between the two).
    if (msg.type === "broadcast-message") {
      if (ws._role !== "dispatcher") return;
      const targets = Array.isArray(msg.targets) ? msg.targets : ["all"];
      const broadcast_msg = {
        type: "broadcast-received",
        text: msg.text,
        senderName: msg.senderName || ws._userName || "Dispatcher",
        senderId: msg.senderId || ws._userId,
        targets: targets,
        ts: msg.ts || Date.now()
      };
      const payload = JSON.stringify(broadcast_msg);
      if (targets.length === 1 && targets[0] === "all") {
        // Send to every connected technician and store for offline ones.
        // For "all", we store the message globally (under key "*") — when a
        // technician joins we replay anything in "*" they haven't seen yet.
        storeBroadcast("*", broadcast_msg);
        for (const [roomId, set] of rooms) {
          if (!roomId.startsWith("fsm-user-")) continue;
          for (const peer of set) {
            if (peer.readyState === 1 && peer._role === "technician") {
              try { peer.send(payload); } catch (e) {}
            }
          }
        }
      } else {
        // Targeted: store per-technician and deliver if online.
        for (const targetId of targets) {
          storeBroadcast(targetId, broadcast_msg);
          const userRoom = "fsm-user-" + targetId;
          const set = rooms.get(userRoom);
          if (!set) continue;
          for (const peer of set) {
            if (peer.readyState === 1) {
              try { peer.send(payload); } catch (e) {}
            }
          }
        }
      }
      return;
    }

    // ---- FSM API proxy (dispatcher only) --------------------------------
    // The browser cannot call the FSM Data API directly due to CORS. The
    // relay proxies the call server-side where there is no CORS restriction.
    // Message: { type:'fsm-fetch', resource:'persons'|'regions'|'query',
    //            token, account, company, clusterHost, [sql] }
    // Response: { type:'fsm-roster', resource, ok, status, data, error }
    if (msg.type === "fsm-fetch") {
      if (ws._role !== "dispatcher") { return; } // only dispatchers may proxy
      const { resource, token, account, company, clusterHost, sql } = msg;
      if (!token || !account || !company || !clusterHost) {
        try { ws.send(JSON.stringify({ type: "fsm-roster", resource,
          ok: false, error: "Missing token/account/company/clusterHost" })); } catch(e){}
        return;
      }
      const headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "X-Client-ID": "fsm-chat-extension",
        "X-Client-Version": "1.0",
        "X-Account-Name": account,
        "X-Company-Name": company
      };
      let fsmUrl, fetchOpts;
      if (resource === "query" && sql) {
        fsmUrl = `https://${clusterHost}/api/query/v1?account=${encodeURIComponent(account)}&company=${encodeURIComponent(company)}&dtos=Person.25;Region.10`;
        fetchOpts = { method: "POST", headers, body: JSON.stringify({ query: sql }) };
      } else if (resource === "persons") {
        // Data API v4 does not support a 'filter' param — use Query API with CoreSQL.
        fsmUrl = `https://${clusterHost}/api/query/v1?account=${encodeURIComponent(account)}&company=${encodeURIComponent(company)}&dtos=Person.25`;
        const personSQL = "SELECT p.id, p.firstName, p.lastName, p.userName, p.type, p.plannableResource, p.regions FROM Person p WHERE p.plannableResource = true AND p.type = 'EMPLOYEE'";
        fetchOpts = { method: "POST", headers, body: JSON.stringify({ query: personSQL }) };
      } else if (resource === "regions") {
        // Region — Data API v4 with just allowed params (no filter needed, fetch all).
        fsmUrl = `https://${clusterHost}/api/data/v4/Region?dtos=Region.10` +
          `&account=${encodeURIComponent(account)}&company=${encodeURIComponent(company)}` +
          `&pageSize=200&fields=${encodeURIComponent("id,code,name,parentId")}`;
        fetchOpts = { method: "GET", headers };
      } else {
        try { ws.send(JSON.stringify({ type: "fsm-roster", resource,
          ok: false, error: "Unknown resource: " + resource })); } catch(e){}
        return;
      }
      // Node's built-in fetch (v18+) or fall back gracefully.
      const doFetch = typeof fetch === "function" ? fetch : null;
      if (!doFetch) {
        try { ws.send(JSON.stringify({ type: "fsm-roster", resource, ok: false,
          error: "Node version does not support fetch. Upgrade to Node 18+." })); } catch(e){}
        return;
      }
      doFetch(fsmUrl, fetchOpts)
        .then(res => res.json().then(data => ({ status: res.status, ok: res.ok, data })))
        .then(({ status, ok, data }) => {
          try { ws.send(JSON.stringify({ type: "fsm-roster", resource, ok, status, data })); }
          catch(e){}
        })
        .catch(err => {
          try { ws.send(JSON.stringify({ type: "fsm-roster", resource, ok: false,
            error: err.message })); } catch(e){}
        });
      return;
    }

    // ---- leaving a specific room (e.g. dispatcher closes an activity) ----
    if (msg.type === "leave") {
      const roomId = msg.roomId;
      if (roomId && ws._rooms && ws._rooms.has(roomId)) {
        const set = rooms.get(roomId);
        if (set) { set.delete(ws); if (set.size === 0) rooms.delete(roomId); }
        ws._rooms.delete(roomId);
        broadcast(roomId, { type: "presence", roomId: roomId, online: false,
          peerCount: roomSize(roomId), userId: ws._userId, role: ws._role,
          dispatcherPresent: dispatcherPresent(roomId),
          technicianPresent: technicianPresent(roomId), roomState: true });
      }
      return;
    }

    // ---- normal traffic (chat / typing / presence / signal) -------------
    const roomId = msg.roomId || GENERIC_ROOM;
    if (!ws._rooms || !ws._rooms.has(roomId)) addToRoom(roomId, ws);

    // Deliver to the activity room as usual.
    broadcast(roomId, msg, ws);

    // Generic-room fallback: a technician CHAT message to an activity room
    // with NO dispatcher present is copied to the generic room + retained.
    if (msg.type === "chat" &&
        roomId !== GENERIC_ROOM &&
        ws._role !== "dispatcher" &&
        !dispatcherPresent(roomId)) {
      const activityId = activityIdFromRoom(roomId);
      // The chat message may carry the sender name as userName or senderName;
      // fall back to the name captured at join time.
      const senderName = msg.userName || msg.senderName || ws._userName || null;
      const entry = {
        activityId: activityId,
        roomId: roomId,
        text: msg.text,
        userId: msg.userId,
        userName: senderName,
        ts: Date.now()
      };
      genericBacklog.push(entry);
      pruneBacklog();
      // Live-notify any dispatcher currently watching the generic room.
      broadcast(GENERIC_ROOM, {
        type: "generic-message",
        activityId: activityId,
        roomId: roomId,
        text: msg.text,
        userId: msg.userId,
        userName: senderName,
        ts: entry.ts
      });
    }
  });

  ws.on("close", () => {
    const myRooms = ws._rooms ? Array.from(ws._rooms) : [];
    removeFromAllRooms(ws);
    for (const roomId of myRooms) {
      broadcast(roomId, { type: "presence", roomId: roomId, online: false,
        peerCount: roomSize(roomId), userId: ws._userId, role: ws._role,
        dispatcherPresent: dispatcherPresent(roomId),
        technicianPresent: technicianPresent(roomId), roomState: true });
    }
  });

  ws.on("error", () => { try { ws.close(); } catch (e) { /* noop */ } });
});

// Liveness: ping frequently so a vanished client (mobile webview suspends or
// network drops WITHOUT a clean close) is detected quickly. When a socket
// misses a pong it is terminated, which fires 'close' -> room cleanup ->
// presence re-broadcast, so the other side's "connected" indicator clears
// within roughly one interval instead of lingering up to a minute.
const heartbeat = setInterval(() => {
  let reaped = false;
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      reaped = true;
      // Remove from rooms synchronously here so the presence refresh below
      // reflects the departure immediately (the async 'close' from terminate()
      // may fire after this sweep computes counts).
      removeFromAllRooms(ws);
      try { ws.terminate(); } catch (e) { /* noop */ }
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* noop */ }
  });
  // If we reaped anyone, proactively refresh presence for every room so the
  // remaining members' "connected" indicators reflect the departure promptly.
  if (reaped) {
    for (const [roomId] of rooms) {
      broadcast(roomId, {
        type: "presence", roomId: roomId, roomState: true,
        dispatcherPresent: dispatcherPresent(roomId),
        technicianPresent: technicianPresent(roomId)
      });
    }
  }
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`FSM Chat WS relay listening on ${HOST}:${PORT} (generic-room fallback enabled)`);
});
