/**
 * WebSocket relay for FSM Chat — cross-device message bridge.
 *
 * This is what lets the technician (phone) and dispatcher (shell/laptop) — two
 * DIFFERENT devices — actually exchange messages. The in-browser BroadcastChannel
 * transport only connects tabs on the SAME machine; for real cross-device chat
 * you need this server in the middle.
 *
 * It relays JSON messages to everyone in the same roomId. Rooms are derived from
 * the activity id (roomId = "fsm-room-<activityId>"), so both clients viewing the
 * same activity meet in the same room.
 *
 * HOSTING (e.g. Render free tier):
 *   - Reads PORT from the environment (required by most hosts).
 *   - Binds 0.0.0.0.
 *   - GET /health returns "ok" for platform health checks.
 *   - Sends periodic pings so idle connections aren't dropped (~60s timeouts
 *     are common on free tiers and would otherwise kill the chat silently).
 *
 * SECURITY (test relay): no authentication. Anyone who knows the URL and a room
 * id can join that room. Fine for testing; for production add auth (e.g. verify
 * the FSM token) and restrict origins.
 *
 * Local run:
 *   npm install ws
 *   node server/ws-server.js
 *   then open the app with ?ws=ws://localhost:8088
 * Hosted: open the app with ?ws=wss://your-host
 */

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8088;
const HOST = "0.0.0.0";

const server = http.createServer((req, res) => {
  // Health check + a friendly root response.
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("FSM Chat WS relay is running. Connect via WebSocket (use wss:// in browsers).");
});

const wss = new WebSocketServer({ server });

// roomId -> Set<socket>
const rooms = new Map();

function joinRoom(roomId, ws) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(ws);
  ws._roomId = roomId;
}

function leaveRoom(ws) {
  const roomId = ws._roomId;
  if (roomId && rooms.has(roomId)) {
    rooms.get(roomId).delete(ws);
    if (rooms.get(roomId).size === 0) rooms.delete(roomId);
  }
}

function roomSize(roomId) {
  return rooms.has(roomId) ? rooms.get(roomId).size : 0;
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

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    const roomId = msg.roomId || "GENERAL";

    if (msg.type === "join") {
      joinRoom(roomId, ws);
      // Tell existing peers someone joined.
      broadcast(roomId, { type: "presence", roomId: roomId,
        userId: msg.userId, userName: msg.userName, role: msg.role,
        online: true }, ws);
      // Tell the newcomer how many peers are already here, so its status can
      // reflect a real peer (not just "channel open").
      try {
        ws.send(JSON.stringify({ type: "presence", roomId: roomId,
          online: roomSize(roomId) > 1, peerCount: roomSize(roomId) - 1,
          self: true }));
      } catch (e) { /* noop */ }
      return;
    }

    if (!ws._roomId) joinRoom(roomId, ws);

    // Relay chat / typing / presence to everyone else in the room.
    broadcast(roomId, msg, ws);
  });

  ws.on("close", () => {
    const roomId = ws._roomId;
    leaveRoom(ws);
    if (roomId) {
      broadcast(roomId, { type: "presence", roomId: roomId, online: false,
        peerCount: roomSize(roomId) });
    }
  });

  ws.on("error", () => {
    try { ws.close(); } catch (e) { /* noop */ }
  });
});

// Keepalive: ping every 30s; terminate sockets that didn't pong (dead).
// Without this, idle hosts silently drop the connection after ~60s.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (e) { /* noop */ }
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* noop */ }
  });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log(`FSM Chat WS relay listening on ${HOST}:${PORT}`);
});
