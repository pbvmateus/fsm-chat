/**
 * Minimal WebSocket relay for FSM Chat.
 *
 * This is OPTIONAL. The app works with no backend at all (it falls back to
 * a same-machine BroadcastChannel transport). Use this server when you want
 * a real cross-device channel — e.g. technician on a phone and dispatcher on
 * a laptop talking to each other.
 *
 * It simply relays JSON messages to everyone in the same roomId. No storage,
 * no auth — meant for testing only.
 *
 * Run:
 *   npm install ws
 *   node server/ws-server.js
 *
 * Then open the app with:  ?ws=ws://localhost:8088
 * (use wss:// behind TLS in any hosted setup)
 */

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8088;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("FSM Chat WS relay. Connect via WebSocket.");
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
      // Tell existing peers someone joined, and tell the newcomer who's here.
      broadcast(roomId, { type: "presence", ...msg, online: true }, ws);
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
      broadcast(roomId, { type: "presence", roomId, online: false });
    }
  });

  ws.on("error", () => {
    try { ws.close(); } catch (e) { /* noop */ }
  });
});

server.listen(PORT, () => {
  console.log(`FSM Chat WS relay listening on :${PORT}`);
});
