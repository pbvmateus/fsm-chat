sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "com/test/fsmchat/model/ChatTransport",
  "com/test/fsmchat/model/VideoCall",
  "sap/m/MessageToast"
], function (Controller, JSONModel, ChatTransport, VideoCall, MessageToast) {
  "use strict";

  return Controller.extend("com.test.fsmchat.controller.Main", {

    onInit: function () {
      var oComponent = this.getOwnerComponent();
      var oCtxModel = oComponent.getModel("context");
      this._ctxModel = oCtxModel;
      var sRoleEarly = oCtxModel.getProperty("/role");

      // Video support check, guarded: if the VideoCall module failed to load
      // or isSupported throws in a strict webview, this must NOT crash onInit
      // (which would break the chat connection entirely). Default to false.
      var bVideoSupported = false;
      try {
        bVideoSupported = !!(VideoCall && VideoCall.isSupported &&
          VideoCall.isSupported());
      } catch (e) {
        bVideoSupported = false;
      }

      // View-local data model.
      this._model = new JSONModel({
        messages: [],
        draft: "",
        peerTyping: false,
        manualId: "",
        // Video call state
        videoSupported: bVideoSupported,
        videoActive: false,
        videoState: "",        // requesting-camera | calling | connecting | connected | ended | error
        videoStatusText: "",
        incomingCall: false,   // viewer: a technician is offering video
        // Generic-room (unattended messages) inbox — dispatcher only.
        isDispatcher: sRoleEarly === "dispatcher",
        isTechnician: sRoleEarly === "technician",
        unattended: [],        // [{activityId, lastText, lastName, count, ts}]
        unattendedCount: 0,
        // Technician-facing: is a dispatcher currently in this activity room?
        dispatcherPresent: false,
        // Dispatcher-facing: is the technician currently in this activity room?
        technicianPresent: false,
        // Name of the other party, learned from their messages/presence.
        peerName: "",
        // Clean activity id for display in the header / labels.
        activityCode: "",
        // Inline FSM API test (dispatcher, ?apitest=1)
        apiTest: /[?&]apitest=1/.test(window.location.search),
        apiTestOut: "(no API test run yet)"
      });
      this.getView().setModel(this._model);

      // Decorate the context model with display helpers.
      var sRole = sRoleEarly;
      var peerRole = sRole === "technician" ? "dispatcher" : "technician";
      var oBundle = oComponent.getModel("i18n").getResourceBundle();
      oCtxModel.setProperty("/_peerRole", peerRole);
      oCtxModel.setProperty("/_peerName", oBundle.getText(
        peerRole === "dispatcher" ? "roleDispatcher" : "roleTechnician"));
      oCtxModel.setProperty("/_peerLabel", oBundle.getText("youAre", [
        oBundle.getText(sRole === "technician"
          ? "roleTechnician" : "roleDispatcher"),
        oCtxModel.getProperty("/_peerName")
      ]));
      this.getView().setModel(oCtxModel, "context");

      this._setConn("idle");

      var that = this;

      // React to the component (re)binding to an activity — either from the
      // Shell selection callback or from manual entry. Each rebind tears down
      // the old transport and connects to the new room.
      if (typeof oComponent.onActivityBound === "function") {
        oComponent.onActivityBound(function (sRoomId) {
          that._connectRoom(sRoomId);
        });
      }

      // When the dispatcher leaves an activity, fall back to watching the
      // generic inbox (and the relay drops us from the activity room, making it
      // unattended again if no other dispatcher remains).
      if (typeof oComponent.onActivityUnbound === "function") {
        oComponent.onActivityUnbound(function () {
          that._model.setProperty("/dispatcherPresent", false);
          if (that._ctxModel.getProperty("/role") === "dispatcher") {
            that._connectGenericOnly();
          }
        });
      }

      // If we already have a room from a launch parameter, connect now.
      var sExistingRoom = oCtxModel.getProperty("/roomId");
      if (sExistingRoom) {
        this._connectRoom(sExistingRoom);
      } else if (sRoleEarly === "dispatcher") {
        // Dispatcher with no activity bound yet: connect anyway so the generic
        // "unattended messages" inbox works while they wait. We use the generic
        // room as the primary room in this case; picking up a conversation will
        // rebind to that activity's room.
        this._connectGenericOnly();
      }

      // Track whether the chat view is actually visible, so presence reflects
      // "in chat" rather than "socket open in the background".
      this._setupActivityTracking();
      // Ask for notification permission (best-effort; may be unavailable in the
      // FSM webview — we fall back to in-app sound + banner).
      this._initNotifications();

      // Clean up on exit.
      this.getView().addEventDelegate({ onExit: this._teardown.bind(this) });
    },

    onExit: function () {
      this._teardown();
    },

    _teardown: function () {
      if (this._typingStopTimer) { clearTimeout(this._typingStopTimer); }
      if (this._video) { this._video.hangup(); this._video = null; }
      this._teardownActivityTracking();
      if (this._transport) {
        this._transport.disconnect();
        this._transport = null;
      }
    },

    _isFramed: function () {
      try { return window.parent && window.parent !== window; }
      catch (e) { return true; }
    },

    _isHidden: function () {
      // In a framed shell extension, document.hidden is unreliable (framed
      // content is often reported hidden even when visible), which would
      // wrongly mark the dispatcher inactive. Only trust visibility when we are
      // NOT framed (the mobile technician runs unframed, where it's reliable).
      if (this._isFramed()) { return false; }
      return (typeof document !== "undefined") && document.hidden === true;
    },

    _sendActivity: function (bActive) {
      this._selfActive = !!bActive;
      if (this._transport && typeof this._transport.sendActivity === "function") {
        try { this._transport.sendActivity(bActive); } catch (e) { /* noop */ }
      }
      // When the technician returns to the chat, surface any banner queued from
      // messages that arrived while they were away.
      if (bActive) { this._flushAwayBanner(); }
    },

    _setupActivityTracking: function () {
      var that = this;
      this._selfActive = !this._isHidden();
      // Visibility change: only meaningful when unframed (mobile). For the
      // framed dispatcher this is a no-op so it stays "active" while open.
      this._onVisibility = function () {
        if (that._isFramed()) { return; }
        that._sendActivity(!that._isHidden());
      };
      // Page being hidden/unloaded (navigated away / app closing): mark
      // inactive. This is reliable in both framed and unframed contexts.
      this._onPageHide = function () {
        that._sendActivity(false);
      };
      if (typeof document !== "undefined" && document.addEventListener) {
        document.addEventListener("visibilitychange", this._onVisibility);
        window.addEventListener("pagehide", this._onPageHide);
      }
    },

    _teardownActivityTracking: function () {
      try {
        if (this._onVisibility) {
          document.removeEventListener("visibilitychange", this._onVisibility);
        }
        if (this._onPageHide) {
          window.removeEventListener("pagehide", this._onPageHide);
        }
      } catch (e) { /* noop */ }
    },

    // ===== Inline FSM Data API test (dispatcher, ?apitest=1) ================
    // Reuses the REAL shell context token/account/host the app already holds,
    // so we avoid the standalone probe's "SDK not loaded / manual token"
    // problem. Results (incl. an HTML-vs-JSON verdict) go to /apiTestOut.

    _apiCtx: function () {
      var m = this._ctxModel;
      var host = m.getProperty("/fsmHost");
      if (host && host.indexOf("http") !== 0) { host = "https://" + host; }
      return {
        host: host,
        account: m.getProperty("/fsmAccount"),
        company: m.getProperty("/fsmCompany"),
        token: m.getProperty("/fsmToken")
      };
    },

    _apiTestShow: function (oObj) {
      var s = (typeof oObj === "string") ? oObj : JSON.stringify(oObj, null, 2);
      this._model.setProperty("/apiTestOut", s);
    },

    _apiTestRun: function (sUrl, sMethod, oBody) {
      var that = this;
      var r = this._apiCtx();
      if (!r.host || !r.account || !r.company || !r.token) {
        this._apiTestShow({
          error: "Missing FSM context — the shell did not provide one of host/account/company/token.",
          have: { host: r.host, account: r.account, company: r.company,
            token: r.token ? ("present(" + String(r.token).length + " chars)") : "MISSING" },
          note: "If token is MISSING, the shell SDK version may not expose authToken to web containers — that itself is the key finding."
        });
        return;
      }
      this._apiTestShow("Calling " + (sMethod || "GET") + " " + sUrl + " …");
      var opts = {
        method: sMethod || "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Client-ID": "fsm-chat-apitest",
          "X-Client-Version": "1.0.0",
          "Authorization": "bearer " + r.token
        }
      };
      if (oBody) { opts.body = JSON.stringify(oBody); }
      fetch(sUrl, opts).then(function (res) {
        return res.text().then(function (text) {
          var looksHtml = /^\s*<!doctype html|<html[\s>]/i.test(text);
          var body; try { body = JSON.parse(text); } catch (e) { body = text; }
          var verdict;
          if (looksHtml) {
            verdict = "WRONG TARGET: HTML came back (the chat app), not FSM. The call was redirected/blocked before reaching the API — almost certainly CORS. Direct browser calls to FSM may not be possible; we'd route via the relay instead.";
          } else if (res.ok) {
            verdict = "OK: real FSM API JSON response.";
          } else if (res.status === 401 || res.status === 403) {
            verdict = "AUTH REJECTED: FSM reached but refused the token (" + res.status + ").";
          } else {
            verdict = "Reached FSM, status " + res.status + " — inspect body (may be a DTO-version issue).";
          }
          that._apiTestShow({
            verdict: verdict, requestUrl: sUrl, finalUrl: res.url,
            redirected: res.redirected, httpStatus: res.status, ok: res.ok,
            body: looksHtml ? "(HTML omitted)" : body
          });
        });
      }).catch(function (e) {
        that._apiTestShow({
          requestUrl: sUrl, error: e.message,
          hint: "A CORS/network error here means the browser blocked the cross-origin call to FSM. That is the decisive finding: the Data API can't be called directly from the dispatcher's browser, so the broadcast feature must proxy through the relay server-side."
        });
      });
    },

    onApiTestPersons: function () {
      var r = this._apiCtx();
      // Person v25; technicians are EMPLOYEE-type persons that are plannable.
      // 'regions' is the Set<Identifier> linking a person to Region(s).
      var u = (r.host || "") + "/api/data/v4/Person?dtos=Person.25" +
        "&account=" + encodeURIComponent(r.account || "") +
        "&company=" + encodeURIComponent(r.company || "") +
        "&pageSize=20&fields=" +
        encodeURIComponent("id,firstName,lastName,userName,type,plannableResource,regions") +
        "&filter=" + encodeURIComponent("plannableResource==true;type==EMPLOYEE");
      this._apiTestRun(u, "GET");
    },

    onApiTestRegions: function () {
      var r = this._apiCtx();
      // Region v10: code, name, parentId (hierarchy).
      var u = (r.host || "") + "/api/data/v4/Region?dtos=Region.10" +
        "&account=" + encodeURIComponent(r.account || "") +
        "&company=" + encodeURIComponent(r.company || "") +
        "&pageSize=50&fields=" + encodeURIComponent("id,code,name,parentId");
      this._apiTestRun(u, "GET");
    },

    onApiTestQuery: function () {
      var r = this._apiCtx();
      var u = (r.host || "") + "/api/query/v1?account=" + encodeURIComponent(r.account || "") +
        "&company=" + encodeURIComponent(r.company || "") + "&dtos=Person.25";
      // CoreSQL cross-check with the corrected field/type.
      var sql = "SELECT p.id, p.firstName, p.lastName, p.userName, p.regions " +
        "FROM Person p WHERE p.plannableResource = true AND p.type = 'EMPLOYEE'";
      this._apiTestRun(u, "POST", { query: sql });
    },

    // ===== Away alerts (dispatcher messaged while technician not viewing) ====

    // Request notification permission once, quietly. If denied or unsupported
    // (likely inside the FSM webview), we silently fall back to sound + banner.
    _initNotifications: function () {
      try {
        if (typeof Notification !== "undefined" &&
            Notification.permission === "default") {
          Notification.requestPermission().catch(function () { /* noop */ });
        }
      } catch (e) { /* noop */ }
    },

    // Called when a peer message arrives while we're away. Best-effort on every
    // channel; any single failure must not break the others or the chat.
    _notifyAway: function (oMsg) {
      var sFrom = oMsg.senderName || oMsg.userName || "Dispatcher";
      var sText = oMsg.text || "";
      // 1) Sound (may be blocked until first user interaction — best effort).
      this._beep();
      // 2) Browser notification (may not work in the FSM webview — best effort).
      try {
        if (typeof Notification !== "undefined" &&
            Notification.permission === "granted") {
          var n = new Notification(sFrom, {
            body: sText,
            tag: "fsm-chat-" + (this._currentRoom || "room")
          });
          // Focus the chat if the user taps the notification.
          n.onclick = function () { try { window.focus(); } catch (e) {} };
        }
      } catch (e) { /* noop */ }
      // 3) Queue a banner to show when they return to the chat.
      this._awayBanner = { from: sFrom, text: sText, count:
        ((this._awayBanner && this._awayBanner.count) || 0) + 1 };
      // If we happen to already be visible (race), flush immediately.
      if (this._selfActive !== false && !this._isHidden()) {
        this._flushAwayBanner();
      }
    },

    _flushAwayBanner: function () {
      if (!this._awayBanner) { return; }
      var b = this._awayBanner;
      this._awayBanner = null;
      try {
        var oBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
        var sMsg = b.count > 1
          ? oBundle.getText("awayMsgsToast", [b.count, b.from])
          : oBundle.getText("awayMsgToast", [b.from]);
        MessageToast.show(sMsg, { duration: 4000 });
      } catch (e) { /* noop */ }
    },

    // Short WebAudio beep — no audio asset needed. Guarded; silent on failure.
    _beep: function () {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { return; }
        if (!this._audioCtx) { this._audioCtx = new AC(); }
        var ctx = this._audioCtx;
        // Browsers may start the context suspended until a user gesture.
        if (ctx.state === "suspended" && ctx.resume) { ctx.resume(); }
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 0.36);
      } catch (e) { /* noop */ }
    },

    /**
     * (Re)connect the chat transport for a given room. Safe to call multiple
     * times; it disconnects any previous transport and clears the thread,
     * since a new activity means a new conversation.
     */
    _connectRoom: function (sRoomId) {
      if (!sRoomId) { return; }

      // If we're already on this room with a live transport, do nothing.
      if (this._transport && this._currentRoom === sRoomId) { return; }

      // Tear down the previous transport/thread.
      if (this._transport) {
        this._transport.disconnect();
        this._transport = null;
      }
      this._model.setProperty("/messages", []);
      this._model.setProperty("/peerTyping", false);
      this._currentRoom = sRoomId;
      this._ctxModel.setProperty("/_room", sRoomId);
      // Clean activity code for labels (strip the room prefix).
      var sCode = sRoomId.indexOf("fsm-room-") === 0
        ? sRoomId.slice("fsm-room-".length) : sRoomId;
      this._model.setProperty("/activityCode", sCode);
      // Reset until the relay tells us whether a dispatcher is present.
      this._model.setProperty("/dispatcherPresent", false);
      this._model.setProperty("/technicianPresent", false);
      // Reset the learned peer name for the new conversation.
      this._model.setProperty("/peerName", "");

      // Build a fresh per-room context object for the transport.
      var oOpts = {
        roomId: sRoomId,
        userId: this._ctxModel.getProperty("/userId"),
        userName: this._ctxModel.getProperty("/userName"),
        role: this._ctxModel.getProperty("/role")
      };

      // A room change ends any active video call.
      if (this._video) { this._video.hangup(); this._video = null; }
      this._model.setProperty("/videoActive", false);
      this._model.setProperty("/incomingCall", false);

      this._setConn("connecting");

      var that = this;
      this._transport = ChatTransport.create(oOpts, {
        onOpen: function () {
          that._setConn("online");
          // Report current chat-view visibility so presence is accurate from
          // the start (and after any reconnect).
          try {
            that._transport.sendActivity(!that._isHidden());
          } catch (e) { /* noop */ }
          // Dispatchers also watch the shared generic room for unattended
          // messages (technician messages sent while no dispatcher was in the
          // activity room). Joining rides the same socket; re-joining on each
          // reconnect/rebind is harmless (relay de-dupes membership).
          if (that._ctxModel.getProperty("/role") === "dispatcher" &&
              typeof that._transport.joinSecondaryRoom === "function") {
            that._transport.joinSecondaryRoom("fsm-generic");
          }
        },
        onClose: function () { that._setConn("offline"); },
        onMessage: function (m) { that._onIncoming(m); },
        onPresence: function (p) { that._onPresence(p); },
        onTyping: function (b) { that._onPeerTyping(b); },
        onSignal: function (sig) { that._onSignal(sig); },
        onGenericMessage: function (g) { that._onGenericMessage(g); },
        onGenericBacklog: function (g) { that._onGenericBacklog(g); },
        onGenericClaimed: function (g) { that._onGenericClaimed(g); }
      });
      this._transport.connect();
    },

    /**
     * Dispatcher (or tester) manually binds a Service Call / Activity id.
     */
    /**
     * Dispatcher-only: connect to the relay with the GENERIC room as primary,
     * for when no activity is bound yet. This lets unattended messages arrive
     * in the inbox immediately on load. When the dispatcher picks up a
     * conversation, _connectRoom rebinds to that activity's room (and the
     * onOpen handler re-joins fsm-generic as a secondary room).
     */
    _connectGenericOnly: function () {
      if (this._transport && this._currentRoom === "fsm-generic") { return; }
      if (this._transport) { this._transport.disconnect(); this._transport = null; }
      this._currentRoom = "fsm-generic";

      var oOpts = {
        roomId: "fsm-generic",
        userId: this._ctxModel.getProperty("/userId"),
        userName: this._ctxModel.getProperty("/userName"),
        role: this._ctxModel.getProperty("/role")
      };
      this._setConn("connecting");
      var that = this;
      this._transport = ChatTransport.create(oOpts, {
        onOpen: function () { that._setConn("online"); },
        onClose: function () { that._setConn("offline"); },
        onMessage: function () { /* no activity thread in generic-only mode */ },
        onPresence: function (p) { that._onPresence(p); },
        onTyping: function () { /* noop */ },
        onSignal: function () { /* noop */ },
        onGenericMessage: function (g) { that._onGenericMessage(g); },
        onGenericBacklog: function (g) { that._onGenericBacklog(g); },
        onGenericClaimed: function (g) { that._onGenericClaimed(g); }
      });
      this._transport.connect();
    },

    /**
     * A live unattended message arrived from the generic room. Fold it into the
     * inbox model grouped by activityId (so repeated messages from the same
     * activity collapse into one row with a count + latest preview).
     */
    _onGenericMessage: function (g) {
      if (!g || !g.activityId) { return; }
      this._upsertUnattended({
        activityId: g.activityId,
        lastText: g.text,
        lastName: g.userName,
        ts: g.ts || Date.now(),
        incr: 1
      });
      var oBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
      MessageToast.show(oBundle.getText("genericNewToast",
        [g.userName || "Technician"]));
    },

    /**
     * The relay replayed the backlog of unattended messages when we joined the
     * generic room. Rebuild the inbox from it (grouped by activity).
     */
    _onGenericBacklog: function (g) {
      if (!g || !Array.isArray(g.items)) { return; }
      var map = {};
      g.items.forEach(function (m) {
        var a = m.activityId;
        if (!map[a]) {
          map[a] = { activityId: a, lastText: m.text, lastName: m.userName,
            ts: m.ts, count: 1 };
        } else {
          map[a].count += 1;
          if ((m.ts || 0) >= (map[a].ts || 0)) {
            map[a].lastText = m.text; map[a].lastName = m.userName; map[a].ts = m.ts;
          }
        }
      });
      var list = Object.keys(map).map(function (k) { return map[k]; });
      list.sort(function (x, y) { return (y.ts || 0) - (x.ts || 0); });
      this._model.setProperty("/unattended", list);
      this._model.setProperty("/unattendedCount", list.length);
    },

    /**
     * Another dispatcher picked up (or any dispatcher joined) an activity, so
     * it's no longer unattended — remove it from this inbox too.
     */
    _onGenericClaimed: function (g) {
      if (!g || !g.activityId) { return; }
      var list = (this._model.getProperty("/unattended") || []).filter(
        function (row) { return row.activityId !== g.activityId; });
      this._model.setProperty("/unattended", list);
      this._model.setProperty("/unattendedCount", list.length);
    },

    _upsertUnattended: function (o) {
      var list = this._model.getProperty("/unattended") || [];
      var found = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].activityId === o.activityId) { found = list[i]; break; }
      }
      if (found) {
        found.lastText = o.lastText;
        found.lastName = o.lastName;
        found.ts = o.ts;
        found.count = (found.count || 0) + (o.incr || 0);
      } else {
        list.unshift({ activityId: o.activityId, lastText: o.lastText,
          lastName: o.lastName, ts: o.ts, count: o.incr || 1 });
      }
      // newest first
      list.sort(function (x, y) { return (y.ts || 0) - (x.ts || 0); });
      this._model.setProperty("/unattended", list);
      this._model.setProperty("/unattendedCount", list.length);
    },

    /**
     * Dispatcher clicks "Pick up" on an unattended conversation. Bind the app
     * to that activity (which rebinds the chat transport to its room). The
     * relay then sees a dispatcher present and stops routing that activity to
     * the generic room, and notifies other dispatchers it's claimed.
     */
    onPickUp: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext();
      if (!oCtx) { return; }
      var sActivityId = oCtx.getProperty("activityId");
      if (!sActivityId) { return; }
      // Remove from our own inbox immediately for snappy feedback.
      this._onGenericClaimed({ activityId: sActivityId });
      // Clear the current-room marker so _connectRoom can't short-circuit if
      // any stale state lingers; this guarantees a real (re)join to the
      // activity room rather than staying on the generic connection.
      this._currentRoom = null;
      // Bind the whole app to this activity (updates header + connects room).
      this.getOwnerComponent().bindActivityManually(sActivityId);
    },

    /**
     * Dispatcher leaves the current activity and returns to the generic inbox.
     * We explicitly leave the activity room on the relay first (so it can mark
     * the activity unattended again if no other dispatcher remains), then
     * unbind the app, which the onActivityUnbound listener turns into a
     * generic-only reconnect.
     */
    onLeaveActivity: function () {
      var sRoom = this._currentRoom;
      if (this._transport && sRoom && sRoom.indexOf("fsm-room-") === 0 &&
          typeof this._transport.leaveSecondaryRoom === "function") {
        // Leave the activity room explicitly. (Even though it's the primary
        // room here, the relay's leave handler removes us from it and
        // recomputes dispatcher presence for any waiting technician.)
        this._transport.leaveSecondaryRoom(sRoom);
      }
      this.getOwnerComponent().unbindActivity();
    },

    onBindManual: function () {
      var sId = (this._model.getProperty("/manualId") || "").trim();
      if (!sId) { return; }
      this.getOwnerComponent().bindActivityManually(sId);
      this._model.setProperty("/manualId", "");
    },

    _setConn: function (sState) {
      var oCtx = this._ctxModel;
      var oBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
      var map = {
        idle: { state: "None", icon: "sap-icon://disconnected",
          text: oBundle.getText("statusIdle") },
        connecting: { state: "Warning", icon: "sap-icon://pending",
          text: oBundle.getText("statusConnecting") },
        online: { state: "Success", icon: "sap-icon://connected",
          text: oBundle.getText("statusOnline") },
        offline: { state: "Error", icon: "sap-icon://disconnected",
          text: oBundle.getText("statusOffline") }
      };
      var cfg = map[sState] || map.offline;
      oCtx.setProperty("/_connState", cfg.state);
      oCtx.setProperty("/_connIcon", cfg.icon);
      oCtx.setProperty("/_connText", cfg.text);
    },

    onTyping: function () {
      if (!this._transport) { return; }
      var that = this;
      this._transport.sendTyping(true);
      if (this._typingStopTimer) { clearTimeout(this._typingStopTimer); }
      this._typingStopTimer = setTimeout(function () {
        if (that._transport) { that._transport.sendTyping(false); }
      }, 1500);
    },

    onSend: function () {
      if (!this._transport) { return; }
      var sText = (this._model.getProperty("/draft") || "").trim();
      if (!sText) { return; }

      var oMsg = {
        msgId: this._ctxModel.getProperty("/userId") + "-" + Date.now() + "-" +
          Math.random().toString(36).slice(2, 6),
        userId: this._ctxModel.getProperty("/userId"),
        senderName: this._ctxModel.getProperty("/userName"),
        userName: this._ctxModel.getProperty("/userName"),
        role: this._ctxModel.getProperty("/role"),
        text: sText,
        ts: ChatTransport.nowISO()
      };

      this._appendMessage(oMsg, true);
      this._transport.send(oMsg);
      this._transport.sendTyping(false);
      this._model.setProperty("/draft", "");
    },

    _onIncoming: function (oMsg) {
      var sMyId = this._ctxModel.getProperty("/userId");
      if (oMsg.userId === sMyId) {
        var existing = this._model.getProperty("/messages")
          .some(function (m) { return m.msgId === oMsg.msgId; });
        if (existing) { return; }
      } else {
        // Learn the other party's name from their message (used in the header).
        var sName = oMsg.senderName || oMsg.userName;
        if (sName && this._model.getProperty("/peerName") !== sName) {
          this._model.setProperty("/peerName", sName);
        }
        // If this message arrived while we're NOT actively viewing the chat
        // (e.g. technician backgrounded the app), alert them: sound + a
        // best-effort browser notification now, and a banner when they return.
        if (this._selfActive === false || this._isHidden()) {
          this._notifyAway(oMsg);
        }
      }
      this._appendMessage(oMsg, oMsg.userId === sMyId);
      this._onPeerTyping(false);
    },

    _appendMessage: function (oMsg, bMine) {
      var aMessages = this._model.getProperty("/messages");
      if (oMsg.msgId && aMessages.some(function (m) {
        return m.msgId === oMsg.msgId;
      })) { return; }

      var oDate = oMsg.ts ? new Date(oMsg.ts) : new Date();
      var oBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
      var sRoleLabel = oMsg.role === "dispatcher"
        ? oBundle.getText("roleDispatcher")
        : (oMsg.role === "technician" ? oBundle.getText("roleTechnician") : "");
      aMessages.push({
        msgId: oMsg.msgId,
        text: oMsg.text,
        senderName: oMsg.senderName || oMsg.userName || "?",
        senderRole: sRoleLabel,
        mine: bMine ? "mine" : "theirs",
        time: oDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      });
      this._model.setProperty("/messages", aMessages);
      this._scrollToBottom();
    },

    _onPresence: function (oP) {
      var sMyId = this._ctxModel.getProperty("/userId");
      if (oP.userId && oP.userId !== sMyId) {
        this._setConn("online");
        // Learn the other party's name from their presence announcement.
        if (oP.userName && this._model.getProperty("/peerName") !== oP.userName) {
          this._model.setProperty("/peerName", oP.userName);
        }
      }
      // The relay includes authoritative role-presence flags on the self-echo
      // (self:true) and room-state broadcasts (roomState:true). Each side uses
      // the relevant one for its header indicator.
      if ((oP.self || oP.roomState)) {
        if (Object.prototype.hasOwnProperty.call(oP, "dispatcherPresent")) {
          this._model.setProperty("/dispatcherPresent", !!oP.dispatcherPresent);
        }
        if (Object.prototype.hasOwnProperty.call(oP, "technicianPresent")) {
          this._model.setProperty("/technicianPresent", !!oP.technicianPresent);
        }
      }
    },

    _onPeerTyping: function (bTyping) {
      this._model.setProperty("/peerTyping", !!bTyping);
      if (bTyping) { this._scrollToBottom(); }
    },

    // ===== Video call =====================================================

    _videoStatus: function (sState) {
      this._model.setProperty("/videoState", sState);
      var map = {
        "requesting-camera": "Starting camera\u2026",
        "calling": "Calling dispatcher\u2026",
        "connecting": "Connecting\u2026",
        "connected": "Live",
        "disconnected": "Reconnecting\u2026",
        "ended": "Call ended",
        "error": "Video error",
        "failed": "Connection failed (may need TURN)"
      };
      this._model.setProperty("/videoStatusText", map[sState] || sState);
      if (sState === "ended" || sState === "error") {
        this._model.setProperty("/videoActive", false);
        this._model.setProperty("/incomingCall", false);
      }
    },

    _makeVideo: function (sCallRole) {
      var that = this;
      return new VideoCall({
        role: sCallRole,
        transport: this._transport,
        onState: function (s) { that._videoStatus(s); },
        onLocalStream: function (stream) { that._attachStream("localVideo", stream, true); },
        onRemoteStream: function (stream) { that._attachStream("remoteVideo", stream, false); },
        onError: function (err) {
          that._videoStatus("error");
          if (that._video) {
            MessageToast.show("Video: " + (err && err.message ? err.message : "failed"));
          }
        }
      });
    },

    // Technician taps "Share video".
    onStartVideo: function () {
      if (!this._transport) { return; }
      if (this._video) { this._video.hangup(); }
      this._model.setProperty("/videoActive", true);
      this._video = this._makeVideo("caller");
      this._video.startAsCaller();
    },

    // Dispatcher accepts an incoming share.
    onAcceptVideo: function () {
      this._model.setProperty("/incomingCall", false);
      this._model.setProperty("/videoActive", true);
      // Viewer was already created when the offer arrived; if the offer is
      // queued, replay it.
      if (this._video && this._pendingOffer) {
        this._video.handleSignal(this._pendingOffer);
        this._pendingOffer = null;
      }
    },

    onDeclineVideo: function () {
      this._model.setProperty("/incomingCall", false);
      this._pendingOffer = null;
      if (this._video) { this._video.hangup(); this._video = null; }
    },

    onEndVideo: function () {
      if (this._video) { this._video.hangup(); this._video = null; }
      this._model.setProperty("/videoActive", false);
      this._model.setProperty("/incomingCall", false);
    },

    _onSignal: function (sig) {
      var that = this;
      // Viewer side: an offer means a technician wants to share video.
      if (sig.signalType === "offer") {
        // Only the dispatcher/viewer should handle offers.
        if (this._ctxModel.getProperty("/role") === "technician") { return; }
        if (!this._video) { this._video = this._makeVideo("viewer"); }
        // Prompt the dispatcher to accept; queue the offer until they do.
        this._pendingOffer = sig;
        this._model.setProperty("/incomingCall", true);
        // Auto-accept so the stream shows immediately; comment out the next
        // two lines if you want an explicit accept tap instead.
        this._model.setProperty("/incomingCall", false);
        this._model.setProperty("/videoActive", true);
        this._video.handleSignal(sig);
        this._pendingOffer = null;
        return;
      }
      // All other signals (answer/candidate/hangup) go to the active call.
      if (this._video) {
        if (sig.signalType === "hangup") {
          this._model.setProperty("/videoActive", false);
          this._model.setProperty("/incomingCall", false);
        }
        this._video.handleSignal(sig);
      }
    },

    _attachStream: function (sVideoId, stream, bMuted) {
      var that = this;
      // The <video> element lives inside an HTML control; attach via DOM after
      // render. Retry briefly since the element may not be in the DOM yet.
      var tries = 0;
      function attach() {
        var el = document.getElementById(that.getView().getId() + "--" + sVideoId);
        if (!el) {
          // Try the raw id too (HTML control content id).
          el = document.getElementById(sVideoId);
        }
        if (el) {
          try { el.srcObject = stream; } catch (e) { el.src = URL.createObjectURL(stream); }
          el.muted = !!bMuted;
          el.play && el.play().catch(function () { /* autoplay may defer */ });
          return;
        }
        if (tries++ < 20) { setTimeout(attach, 100); }
      }
      attach();
    },

    _scrollToBottom: function () {
      var that = this;
      setTimeout(function () {
        var oCont = that.byId("msgContainer");
        var oDom = oCont && oCont.getDomRef();
        if (!oDom) { return; }
        // The page scrolls as one unit now (header is sticky). Bring the bottom
        // of the message container into view. Try the nearest scrollable
        // ancestor, then fall back to scrolling the last child into view.
        try {
          var el = oDom.parentNode;
          while (el && el !== document.body) {
            var oy = window.getComputedStyle(el).overflowY;
            if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) {
              el.scrollTop = el.scrollHeight;
              return;
            }
            el = el.parentNode;
          }
        } catch (e) { /* fall through */ }
        // Fallback: scroll the last message into view.
        var last = oDom.lastElementChild;
        if (last && last.scrollIntoView) {
          last.scrollIntoView({ block: "end" });
        }
      }, 80);
    }
  });
});
