sap.ui.define([], function () {
  "use strict";

  /**
   * ChatTransport abstracts how messages move between the technician and
   * dispatcher clients. Two implementations are provided:
   *
   *   1. WebSocketTransport  - real-time via a WS server (the included
   *      Node server, or any compatible endpoint). Use this for a true
   *      cross-device channel (mobile <-> shell).
   *
   *   2. LocalTransport       - BroadcastChannel + localStorage. No backend
   *      needed; lets you test two browser tabs/windows on the SAME machine
   *      (e.g. on GitHub Pages). Messages persist per room in localStorage.
   *
   * Selection: ?ws=wss://your-server  -> WebSocketTransport
   *            otherwise               -> LocalTransport
   *
   * Both emit the same events via the provided handler:
   *   onMessage(msg), onPresence(state), onTyping(bool), onOpen(), onClose()
   */

  function nowISO() {
    return new Date().toISOString();
  }

  // ---- WebSocket transport -------------------------------------------------
  function WebSocketTransport(sUrl, oOpts, oHandlers) {
    this._url = sUrl;
    this._opts = oOpts;
    this._h = oHandlers;
    this._ws = null;
    this._reconnectMs = 1000;
    this._closedByUser = false;
  }

  WebSocketTransport.prototype.connect = function () {
    var that = this;
    this._closedByUser = false;
    try {
      this._ws = new WebSocket(this._url);
    } catch (e) {
      this._h.onClose && this._h.onClose();
      return;
    }

    this._ws.onopen = function () {
      that._reconnectMs = 1000;
      // Announce join so the peer learns our identity.
      that._raw({
        type: "join",
        roomId: that._opts.roomId,
        userId: that._opts.userId,
        userName: that._opts.userName,
        role: that._opts.role
      });
      that._h.onOpen && that._h.onOpen();
    };

    this._ws.onmessage = function (evt) {
      var data;
      try { data = JSON.parse(evt.data); } catch (e) { return; }

      // Generic-room (unattended message) traffic carries roomId "fsm-generic"
      // and must NOT be filtered out by the activity-room check below. Handle it
      // first and return.
      switch (data.type) {
        case "generic-message":
          that._h.onGenericMessage && that._h.onGenericMessage(data);
          return;
        case "generic-backlog":
          that._h.onGenericBacklog && that._h.onGenericBacklog(data);
          return;
        case "generic-claimed":
          that._h.onGenericClaimed && that._h.onGenericClaimed(data);
          return;
        case "broadcast-received":
          that._h.onBroadcastReceived && that._h.onBroadcastReceived(data);
          return;
        case "broadcast-history":
          that._h.onBroadcastHistory && that._h.onBroadcastHistory(data);
          return;
        case "direct-chat":
          that._h.onDirectChat && that._h.onDirectChat(data);
          return;
        case "fsm-roster":
          that._h.onFsmRoster && that._h.onFsmRoster(data);
          return;
        default:
          break;
      }

      // For ordinary traffic, only accept messages for our primary activity
      // room. (Presence/typing/chat/signal are all room-scoped.)
      if (data.roomId && data.roomId !== that._opts.roomId) {
        return; // not our room
      }
      switch (data.type) {
        case "chat":
          that._h.onMessage && that._h.onMessage(data);
          break;
        case "join":
        case "presence":
          that._h.onPresence && that._h.onPresence(data);
          break;
        case "typing":
          if (data.userId !== that._opts.userId) {
            that._h.onTyping && that._h.onTyping(!!data.typing, data);
          }
          break;
        case "signal":
          // WebRTC signaling (offer/answer/candidate/control). Ignore our own
          // echoes; deliver peer signals to the handler.
          if (data.from !== that._opts.userId) {
            that._h.onSignal && that._h.onSignal(data);
          }
          break;
        default:
          break;
      }
    };

    this._ws.onclose = function () {
      that._h.onClose && that._h.onClose();
      if (!that._closedByUser) {
        setTimeout(function () { that.connect(); },
          Math.min(that._reconnectMs, 10000));
        that._reconnectMs *= 2;
      }
    };

    this._ws.onerror = function () {
      try { that._ws.close(); } catch (e) { /* noop */ }
    };
  };

  WebSocketTransport.prototype._raw = function (obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  };

  WebSocketTransport.prototype.send = function (msg) {
    this._raw(Object.assign({ type: "chat", roomId: this._opts.roomId }, msg));
  };

  WebSocketTransport.prototype.sendTyping = function (bTyping) {
    this._raw({
      type: "typing",
      roomId: this._opts.roomId,
      userId: this._opts.userId,
      userName: this._opts.userName,
      typing: bTyping
    });
  };

  // WebRTC signaling: send an offer/answer/candidate/control message to the room.
  // `payload` carries { signalType, ... }. We tag from/userName so the peer can
  // identify the sender and ignore its own echoes.
  WebSocketTransport.prototype.sendSignal = function (payload) {
    this._raw(Object.assign({
      type: "signal",
      roomId: this._opts.roomId,
      from: this._opts.userId,
      fromName: this._opts.userName,
      fromRole: this._opts.role
    }, payload));
  };

  // Report whether the chat view is currently visible/active to the user, so
  // the relay can base presence on "in chat" rather than "socket open".
  // Send a message in the technician's always-open direct channel.
  // Tell the relay to clear this technician's stored broadcast history.
  WebSocketTransport.prototype.clearBroadcasts = function () {
    this._raw({
      type: "clear-broadcasts",
      userName: this._opts.userName
    });
  };

  WebSocketTransport.prototype.isConnected = function () {
    return this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1);
  };

  WebSocketTransport.prototype.sendDirectChat = function (sText, sRoomId) {
    this._raw({
      type: "direct-chat",
      roomId: sRoomId || null,
      text: sText,
      userName: this._opts.userName,
      userId: this._opts.userId,
      role: this._opts.role,
      ts: new Date().toISOString()
    });
  };

  // Send a broadcast message to specific technician userIds (or all).
  WebSocketTransport.prototype.sendBroadcast = function (sText, aTargets) {
    this._raw({
      type: "broadcast-message",
      text: sText,
      targets: aTargets || ["all"],
      senderName: this._opts.userName,
      senderId: this._opts.userId,
      ts: new Date().toISOString()
    });
  };

  // Request the FSM roster (persons + regions) via the relay proxy.
  WebSocketTransport.prototype.requestRoster = function (oFsmCtx) {
    this._raw({
      type: "fsm-fetch",
      resource: "query",
      sql: "SELECT p.id, p.firstName, p.lastName, p.userName, p.regions FROM Person p WHERE p.plannableResource = true AND p.type = 'EMPLOYEE'",
      token: oFsmCtx.token,
      account: oFsmCtx.account,
      company: oFsmCtx.company,
      clusterHost: oFsmCtx.host
    });
    this._raw({
      type: "fsm-fetch",
      resource: "regions",
      token: oFsmCtx.token,
      account: oFsmCtx.account,
      company: oFsmCtx.company,
      clusterHost: oFsmCtx.host
    });
  };

  WebSocketTransport.prototype.sendActivity = function (bActive) {
    this._raw({ type: "activity", active: !!bActive });
  };

  WebSocketTransport.prototype.disconnect = function () {
    this._closedByUser = true;
    if (this._ws) {
      try { this._ws.close(); } catch (e) { /* noop */ }
    }
  };

  // Join an ADDITIONAL room over the same socket without leaving the primary
  // activity room. Used so a dispatcher can watch "fsm-generic" for unattended
  // messages while still bound to their own activity room (if any).
  WebSocketTransport.prototype.joinSecondaryRoom = function (sRoomId) {
    this._raw({
      type: "join",
      roomId: sRoomId,
      userId: this._opts.userId,
      userName: this._opts.userName,
      role: this._opts.role
    });
  };

  // Dispatcher "picks up" an unattended conversation: join that activity's room.
  // Once joined, the relay sees a dispatcher present there and stops routing
  // that activity's messages to the generic room. Returns the room id joined.
  WebSocketTransport.prototype.claimActivityRoom = function (sActivityId) {
    var roomId = "fsm-room-" + sActivityId;
    this.joinSecondaryRoom(roomId);
    return roomId;
  };

  WebSocketTransport.prototype.leaveSecondaryRoom = function (sRoomId) {
    this._raw({ type: "leave", roomId: sRoomId });
  };

  WebSocketTransport.prototype.kind = function () { return "relay"; };

  // ---- Local transport (no backend) ---------------------------------------
  function LocalTransport(oOpts, oHandlers) {
    this._opts = oOpts;
    this._h = oHandlers;
    this._chanName = "fsmchat:" + oOpts.roomId;
    this._storeKey = "fsmchat:store:" + oOpts.roomId;
    this._bc = null;
    this._typingTimer = null;
  }

  LocalTransport.prototype.connect = function () {
    var that = this;

    // Replay history from localStorage so a newly opened tab sees prior chat.
    var history = this._readStore();
    history.forEach(function (m) {
      that._h.onMessage && that._h.onMessage(m);
    });

    if (typeof BroadcastChannel !== "undefined") {
      this._bc = new BroadcastChannel(this._chanName);
      this._bc.onmessage = function (evt) {
        that._dispatch(evt.data);
      };
    } else {
      // Fallback for browsers without BroadcastChannel: storage events.
      this._onStorage = function (e) {
        if (e.key === that._chanName + ":signal" && e.newValue) {
          try { that._dispatch(JSON.parse(e.newValue)); } catch (x) { /* noop */ }
        }
      };
      window.addEventListener("storage", this._onStorage);
    }

    // We're "online" immediately in local mode.
    setTimeout(function () {
      that._h.onOpen && that._h.onOpen();
      // Announce presence to any peer tab.
      that._post({
        type: "presence",
        userId: that._opts.userId,
        userName: that._opts.userName,
        role: that._opts.role,
        online: true
      });
    }, 50);
  };

  LocalTransport.prototype._dispatch = function (data) {
    if (!data) { return; }
    // Signaling: ignore our own echoes, deliver peers'.
    if (data.type === "signal") {
      if (data.from !== this._opts.userId) {
        this._h.onSignal && this._h.onSignal(data);
      }
      return;
    }
    if (data.userId === this._opts.userId) {
      // Ignore our own echoes for presence/typing; chat is handled on send.
      if (data.type === "chat") { return; }
      if (data.type !== "chat") { return; }
    }
    switch (data.type) {
      case "chat":
        this._h.onMessage && this._h.onMessage(data);
        break;
      case "presence":
        this._h.onPresence && this._h.onPresence(data);
        break;
      case "typing":
        this._h.onTyping && this._h.onTyping(!!data.typing, data);
        break;
      default:
        break;
    }
  };

  LocalTransport.prototype._post = function (obj) {
    var payload = Object.assign({ roomId: this._opts.roomId }, obj);
    if (this._bc) {
      this._bc.postMessage(payload);
    } else {
      // storage-event signalling
      localStorage.setItem(this._chanName + ":signal",
        JSON.stringify(payload));
      localStorage.removeItem(this._chanName + ":signal");
    }
  };

  LocalTransport.prototype._readStore = function () {
    try {
      return JSON.parse(localStorage.getItem(this._storeKey) || "[]");
    } catch (e) {
      return [];
    }
  };

  LocalTransport.prototype._appendStore = function (msg) {
    var arr = this._readStore();
    arr.push(msg);
    // Keep last 200 messages.
    if (arr.length > 200) { arr = arr.slice(arr.length - 200); }
    localStorage.setItem(this._storeKey, JSON.stringify(arr));
  };

  LocalTransport.prototype.send = function (msg) {
    var full = Object.assign({ type: "chat" }, msg);
    this._appendStore(full);
    this._post(full);
  };

  LocalTransport.prototype.sendTyping = function (bTyping) {
    this._post({
      type: "typing",
      userId: this._opts.userId,
      userName: this._opts.userName,
      typing: bTyping
    });
  };

  LocalTransport.prototype.disconnect = function () {
    if (this._bc) { this._bc.close(); }
    if (this._onStorage) {
      window.removeEventListener("storage", this._onStorage);
    }
  };

  LocalTransport.prototype.kind = function () { return "local"; };

  // Local (same-machine) mode can't implement cross-dispatcher generic rooms;
  // these are no-ops so the dispatcher UI code can call them uniformly.
  LocalTransport.prototype.joinSecondaryRoom = function () { /* noop */ };
  LocalTransport.prototype.claimActivityRoom = function (sActivityId) {
    return "fsm-room-" + sActivityId;
  };
  LocalTransport.prototype.leaveSecondaryRoom = function () { /* noop */ };
  LocalTransport.prototype.sendActivity = function () { /* noop */ };
  LocalTransport.prototype.sendDirectChat = function () { /* noop */ };

  // Signaling over BroadcastChannel (same-machine only; real cross-device video
  // requires the relay). Provided so the API matches WebSocketTransport.
  LocalTransport.prototype.sendSignal = function (payload) {
    this._post(Object.assign({
      type: "signal",
      from: this._opts.userId,
      fromName: this._opts.userName,
      fromRole: this._opts.role
    }, payload));
  };

  // ---- Factory -------------------------------------------------------------
  //
  // Transport selection:
  //   ?ws=wss://host   -> use that relay (explicit override)
  //   ?ws=local        -> force same-machine BroadcastChannel (testing only)
  //   (nothing)        -> use DEFAULT_RELAY below
  //
  // WHY A HARDCODED DEFAULT: the FSM mobile Web Container loads the app via a
  // POST→redirect, and the embedded webview was observed to NOT carry the `ws=`
  // query param through reliably. When `ws=` is lost, the app would fall back to
  // BroadcastChannel, which only connects same-machine — so a phone and a laptop
  // never meet (each shows "online" against an empty local channel). Baking the
  // relay URL in removes that fragile dependency: cross-device works even if the
  // webview strips every query param. Update DEFAULT_RELAY if you redeploy the
  // relay to a different host.
  var DEFAULT_RELAY = "wss://fsm-chat-relay.onrender.com";

  return {
    create: function (oOpts, oHandlers) {
      var params = new URLSearchParams(window.location.search);
      var wsUrl = params.get("ws");

      // Explicit opt-out for local same-machine testing.
      if (wsUrl === "local" || wsUrl === "none" || wsUrl === "bc") {
        return new LocalTransport(oOpts, oHandlers);
      }

      // Explicit relay override, else the baked-in default relay.
      var relay = (wsUrl && wsUrl.indexOf("ws") === 0) ? wsUrl : DEFAULT_RELAY;
      return new WebSocketTransport(relay, oOpts, oHandlers);
    },
    nowISO: nowISO
  };
});
