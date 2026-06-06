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

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("FSM Chat WS relay is running. Connect via WebSocket (use wss:// in browsers).");
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

// Is at least one peer of the given role currently present in this room?
function rolePresent(roomId, role) {
  const set = rooms.get(roomId);
  if (!set) return false;
  for (const peer of set) {
    if (peer.readyState === peer.OPEN && peer._role === role) return true;
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
  return (roomId && roomId.indexOf("fsm-room-") === 0)
    ? roomId.slice("fsm-room-".length) : roomId;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws._role = null;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    // ---- join a room -----------------------------------------------------
    if (msg.type === "join") {
      const roomId = msg.roomId || GENERIC_ROOM;
      if (msg.role) ws._role = msg.role;
      if (msg.userId) ws._userId = msg.userId;
      if (msg.userName) ws._userName = msg.userName;
      addToRoom(roomId, ws);

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
const HEARTBEAT_MS = 10000;
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
