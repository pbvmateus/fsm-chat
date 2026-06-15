sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "com/test/fsmchat/model/ChatTransport",
  "com/test/fsmchat/model/VideoCall"
], function (Controller, JSONModel, MessageToast, ChatTransport, VideoCall) {
  "use strict";

  return Controller.extend("com.test.fsmchat.controller.DirectChat", {

    onInit: function () {
      var oComponent = this.getOwnerComponent();
      var that = this;
      this._ctxModel = oComponent.getModel("context");

      var bVideoSupported = false;
      try { bVideoSupported = !!(VideoCall && VideoCall.isSupported && VideoCall.isSupported()); } catch(e){}

      this._model = new JSONModel({
        activeTab: "broadcasts",
        broadcasts: [],
        unreadCount: 0,
        directMessages: [],
        directDraft: "",
        videoSupported: bVideoSupported,
        videoActive: false,
        videoState: "",
        videoStatusText: "",
        incomingCall: false
      });
      this.getView().setModel(this._model);
      this.getView().setModel(this._ctxModel, "context");
      this.getView().setModel(oComponent.getModel("i18n"), "i18n");

      this._syncBroadcastsFromApp();

      var sUserId = this._ctxModel.getProperty("/userId");
      if (sUserId) {
        this._connectDirect();
      } else {
        var nAttempts = 0;
        var oRetry = setInterval(function () {
          nAttempts++;
          var sId = that._ctxModel.getProperty("/userId");
          if (sId || nAttempts >= 20) {
            clearInterval(oRetry);
            if (sId) { that._connectDirect(); }
          }
        }, 100);
      }

      this._onBroadcastBound = this._onBroadcastEvent.bind(this);
      this._onDirectBound = function (oEvent) {
        var m = oEvent.getParameter("message");
        if (m) { that._onDirectIncoming(m); }
      };
      this._onHistoryBound = function (oEvent) {
        var aItems = oEvent.getParameter("items") || [];
        if (aItems.length) { that._loadBroadcasts(aItems); }
      };
      oComponent.attachEvent("broadcastReceived", this._onBroadcastBound);
      oComponent.attachEvent("directChatReceived", this._onDirectBound);
      oComponent.attachEvent("broadcastHistoryLoaded", this._onHistoryBound);

      if (this._model.getProperty("/activeTab") === "broadcasts") {
        setTimeout(this._markBroadcastsRead.bind(this), 300);
      }
    },

    _syncBroadcastsFromApp: function () {
      var oComponent = this.getOwnerComponent();
      var aBC = oComponent.getBgBroadcasts ? oComponent.getBgBroadcasts() : [];
      if (!aBC.length) {
        var oAppModel = oComponent.getModel("app");
        if (oAppModel) { aBC = oAppModel.getProperty("/broadcasts") || []; }
      }
      this._loadBroadcasts(aBC);
    },

    _loadBroadcasts: function (aItems) {
      if (!aItems || !aItems.length) { return; }
      var aExisting = this._model.getProperty("/broadcasts") || [];
      var oKeys = {};
      aExisting.forEach(function (m) { oKeys[(m.ts || "") + "|" + m.text] = true; });
      var bTabActive = this._model.getProperty("/activeTab") === "broadcasts";
      var aNew = [];
      aItems.forEach(function (m) {
        var sKey = (m.ts || "") + "|" + m.text;
        if (oKeys[sKey]) { return; }
        oKeys[sKey] = true;
        var bRead = bTabActive ? true : !!m.read;
        aNew.push({ text: m.text, senderName: m.senderName || "Dispatcher",
          ts: m.ts || new Date().toISOString(), read: bRead });
      });
      if (!aNew.length) { return; }
      var aMerged = aNew.concat(aExisting);
      aMerged.sort(function (a, b) {
        return new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime();
      });
      this._model.setProperty("/broadcasts", aMerged);
      var nUnread = aMerged.filter(function (m) { return !m.read; }).length;
      this._model.setProperty("/unreadCount", nUnread);
    },

    _onBroadcastEvent: function (oEvent) {
      var oMsg = oEvent.getParameter("message");
      if (!oMsg || !oMsg.text) { return; }
      this._loadBroadcasts([oMsg]);
    },

    _markBroadcastsRead: function () {
      var aBC = this._model.getProperty("/broadcasts") || [];
      var bChanged = false;
      aBC.forEach(function (m) { if (!m.read) { m.read = true; bChanged = true; } });
      if (bChanged) {
        this._model.setProperty("/broadcasts", aBC.slice());
        this._model.setProperty("/unreadCount", 0);
      }
    },

    onClearBroadcasts: function () {
      this._model.setProperty("/broadcasts", []);
      this._model.setProperty("/unreadCount", 0);
      var oComp = this.getOwnerComponent();
      if (oComp._bgBroadcasts) { oComp._bgBroadcasts = []; }
      if (oComp._bgSeenKeys) { oComp._bgSeenKeys.clear(); }
      oComp._bgClearedAt = Date.now();
      // Tell the relay to clear the server-side history for this technician so
      // the messages don't come back after the webview is destroyed/reopened.
      if (this._transport && typeof this._transport.clearBroadcasts === "function") {
        this._transport.clearBroadcasts();
      }
    },

    onTabSelect: function (oEvent) {
      var sKey = oEvent.getParameter("key");
      this._model.setProperty("/activeTab", sKey);
      if (sKey === "broadcasts") {
        setTimeout(this._markBroadcastsRead.bind(this), 200);
      }
    },

    _connectDirect: function () {
      if (this._transport) { return; }
      var sUserId   = this._ctxModel.getProperty("/userId");
      var sUserName = this._ctxModel.getProperty("/userName");
      var sRole     = this._ctxModel.getProperty("/role");
      var sUserKey  = (sUserName || sUserId || "unknown").toLowerCase();
      this._directRoom = "fsm-direct-" + sUserKey;
      var oOpts = { roomId: this._directRoom, userId: sUserId, userName: sUserName, role: sRole };
      var that = this;
      this._transport = ChatTransport.create(oOpts, {
        onOpen: function () {
          that._ctxModel.setProperty("/_connState", "Success");
          that._ctxModel.setProperty("/_connText", "Online");
          that._ctxModel.setProperty("/_connIcon", "sap-icon://connected");
        },
        onClose: function () {
          that._ctxModel.setProperty("/_connState", "Error");
          that._ctxModel.setProperty("/_connText", "Offline");
          that._ctxModel.setProperty("/_connIcon", "sap-icon://disconnected");
          if (that._video) { that._video.hangup(); that._video = null; }
          that._model.setProperty("/videoActive", false);
        },
        onMessage: function (m) { that._onDirectIncoming(m); },
        onDirectChat: function (m) { that._onDirectIncoming(m); },
        onDirectHistory: function (data) {
          var items = (data && data.items) || [];
          that._loadDirectHistory(items);
        },
        onSignal: function (sig) { that._onSignal(sig); },
        onBroadcastReceived: function (m) {
          that._onBroadcastEvent({ getParameter: function (k) { return k === "message" ? m : null; } });
        },
        onBroadcastHistory: function (data) {
          var items = (data && data.items) || [];
          if (items.length) { that._loadBroadcasts(items); }
        },
        onPresence: function () {},
        onTyping: function () {},
        onGenericMessage: function () {},
        onGenericBacklog: function () {},
        onGenericClaimed: function () {},
        onFsmRoster: function () {}
      });
      this._transport.connect();
    },

    _loadDirectHistory: function (aItems) {
      if (!aItems || !aItems.length) { return; }
      var sMyRole = this._ctxModel.getProperty("/role");
      var oBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
      var aExisting = this._model.getProperty("/directMessages") || [];
      // Dedup against what's already shown (by ts+text).
      var oSeen = {};
      aExisting.forEach(function (m) { oSeen[(m._ts || "") + "|" + m.text] = true; });
      var that = this;
      var aAdd = [];
      aItems.forEach(function (m) {
        var sKey = (m.ts || "") + "|" + m.text;
        if (oSeen[sKey]) { return; }
        oSeen[sKey] = true;
        var bMine = m.role && sMyRole && m.role === sMyRole;
        var sRoleLabel = m.role === "dispatcher"
          ? oBundle.getText("roleDispatcher")
          : (m.role === "technician" ? oBundle.getText("roleTechnician") : "");
        var oDate = m.ts ? new Date(m.ts) : new Date();
        aAdd.push({
          text: m.text,
          senderName: m.userName || "?",
          senderRole: sRoleLabel,
          mine: bMine ? "mine" : "theirs",
          time: oDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          _ts: m.ts
        });
        // Mark as seen in the dedup set so live echoes don't double up.
        var sDedupKey = (m.ts || "") + "|" + m.text + "|" + (m.userId || m.userName || "");
        that._directSeen = that._directSeen || {};
        that._directSeen[sDedupKey] = Date.now();
      });
      if (!aAdd.length) { return; }
      // History is oldest-first; existing live messages (if any) go after.
      var aMerged = aAdd.concat(aExisting);
      // Sort by timestamp to keep chronological order.
      aMerged.sort(function (a, b) {
        return (new Date(a._ts || 0).getTime() || 0) - (new Date(b._ts || 0).getTime() || 0);
      });
      this._model.setProperty("/directMessages", aMerged);
      setTimeout(this._scrollToBottom.bind(this), 100);
    },

    _onDirectIncoming: function (oMsg) {
      if (!oMsg || !oMsg.text) { return; }
      var sMyId   = this._ctxModel.getProperty("/userId");
      var sMyRole = this._ctxModel.getProperty("/role");
      // A message is "mine" (an echo of what I sent) ONLY if it comes from the
      // same role as me. Matching by userName is WRONG because in some tenants
      // the dispatcher and technician share the same userName (e.g. PMATEUS) —
      // that would make the technician discard the dispatcher's messages.
      // The incoming role tells us who actually sent it.
      var sMsgRole = oMsg.role || "";
      var bMine = (sMsgRole && sMyRole && sMsgRole === sMyRole) ||
                  (oMsg.userId && sMyId && oMsg.userId === sMyId);
      // Skip echoes of our own messages — already added optimistically on send.
      if (bMine) { return; }
      // Deduplicate true double-deliveries (same message on both sockets).
      var sKey = (oMsg.ts || "") + "|" + oMsg.text + "|" + (oMsg.userId || oMsg.userName || "");
      this._directSeen = this._directSeen || {};
      if (this._directSeen[sKey]) { return; }
      this._directSeen[sKey] = Date.now();
      var nNow = Date.now();
      for (var k in this._directSeen) {
        if (nNow - this._directSeen[k] > 10000) { delete this._directSeen[k]; }
      }
      var oDate = oMsg.ts ? new Date(oMsg.ts) : new Date();
      var oBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
      var sRoleLabel = oMsg.role === "dispatcher"
        ? oBundle.getText("roleDispatcher")
        : (oMsg.role === "technician" ? oBundle.getText("roleTechnician") : "");
      var aMessages = this._model.getProperty("/directMessages") || [];
      aMessages.push({
        text: oMsg.text, senderName: oMsg.userName || oMsg.senderName || "?",
        senderRole: sRoleLabel, mine: "theirs",
        time: oDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        _ts: oMsg.ts
      });
      this._model.setProperty("/directMessages", aMessages);
      setTimeout(this._scrollToBottom.bind(this), 80);
    },

    _scrollToBottom: function () {
      var oCont = this.byId("directMsgContainer");
      var oDom = oCont && oCont.getDomRef();
      if (!oDom) { return; }
      try {
        var el = oDom.parentNode;
        while (el && el !== document.body) {
          var oy = window.getComputedStyle(el).overflowY;
          if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) {
            el.scrollTop = el.scrollHeight; return;
          }
          el = el.parentNode;
        }
      } catch (e) {}
      var last = oDom.lastElementChild;
      if (last && last.scrollIntoView) { last.scrollIntoView({ block: "end" }); }
    },

    onDirectSend: function () {
      var sText = (this._model.getProperty("/directDraft") || "").trim();
      if (!sText) { return; }
      if (!this._transport) { MessageToast.show("Not connected."); return; }
      var oDate = new Date();
      var oBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
      var aMessages = this._model.getProperty("/directMessages") || [];
      aMessages.push({
        text: sText,
        senderName: this._ctxModel.getProperty("/userName") || "Me",
        senderRole: oBundle.getText("roleTechnician"),
        mine: "mine",
        time: oDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        _ts: oDate.toISOString()
      });
      this._model.setProperty("/directMessages", aMessages);
      this._model.setProperty("/directDraft", "");
      if (typeof this._transport.sendDirectChat === "function") {
        this._transport.sendDirectChat(sText, this._directRoom);
      }
      setTimeout(this._scrollToBottom.bind(this), 80);
    },

    // ── Video ──────────────────────────────────────────────────────────────

    _videoStatus: function (sState) {
      this._model.setProperty("/videoState", sState);
      var map = {
        "requesting-camera": "Starting camera\u2026",
        "calling": "Calling\u2026",
        "connecting": "Connecting\u2026",
        "connected": "Live",
        "disconnected": "Reconnecting\u2026",
        "ended": "Call ended",
        "error": "Video error",
        "failed": "Connection failed"
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
        onLocalStream: function (stream) { that._attachStream("directLocalVideo", stream, true); },
        onRemoteStream: function (stream) { that._attachStream("directRemoteVideo", stream, false); },
        onError: function (err) {
          that._videoStatus("error");
          MessageToast.show("Video: " + (err && err.message ? err.message : "failed"));
        }
      });
    },

    onStartVideo: function () {
      if (!this._transport) { return; }
      if (this._video) { this._video.hangup(); }
      this._model.setProperty("/videoActive", true);
      this._video = this._makeVideo("caller");
      this._video.startAsCaller();
    },

    onAcceptVideo: function () {
      this._model.setProperty("/incomingCall", false);
      this._model.setProperty("/videoActive", true);
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
      if (sig.signalType === "offer") {
        if (this._ctxModel.getProperty("/role") === "technician") { return; }
        if (!this._video) { this._video = this._makeVideo("viewer"); }
        this._pendingOffer = sig;
        this._model.setProperty("/incomingCall", true);
        // Auto-accept.
        this._model.setProperty("/incomingCall", false);
        this._model.setProperty("/videoActive", true);
        this._video.handleSignal(sig);
        this._pendingOffer = null;
        return;
      }
      if (this._video) {
        if (sig.signalType === "hangup") {
          this._model.setProperty("/videoActive", false);
          this._model.setProperty("/incomingCall", false);
        }
        this._video.handleSignal(sig);
      }
    },

    _attachStream: function (sVideoId, stream, bMuted) {
      setTimeout(function () {
        var el = document.getElementById(sVideoId);
        if (!el) { return; }
        try {
          el.srcObject = stream;
          if (bMuted) { el.muted = true; }
          el.play().catch(function () {});
        } catch (e) {}
      }, 100);
    },

    onExit: function () {
      if (this._video) { this._video.hangup(); this._video = null; }
      if (this._transport) { this._transport.disconnect(); this._transport = null; }
      var oComp = this.getOwnerComponent();
      if (this._onBroadcastBound) oComp.detachEvent("broadcastReceived", this._onBroadcastBound);
      if (this._onDirectBound)    oComp.detachEvent("directChatReceived", this._onDirectBound);
      if (this._onHistoryBound)   oComp.detachEvent("broadcastHistoryLoaded", this._onHistoryBound);
    }
  });
});
