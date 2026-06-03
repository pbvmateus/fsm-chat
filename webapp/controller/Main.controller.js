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

      // View-local data model.
      this._model = new JSONModel({
        messages: [],
        draft: "",
        peerTyping: false,
        manualId: "",
        // Video call state
        videoSupported: VideoCall.isSupported(),
        videoActive: false,
        videoState: "",        // requesting-camera | calling | connecting | connected | ended | error
        videoStatusText: "",
        incomingCall: false    // viewer: a technician is offering video
      });
      this.getView().setModel(this._model);

      // Decorate the context model with display helpers.
      var sRole = oCtxModel.getProperty("/role");
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

      // If we already have a room from a launch parameter, connect now.
      var sExistingRoom = oCtxModel.getProperty("/roomId");
      if (sExistingRoom) {
        this._connectRoom(sExistingRoom);
      }

      // Clean up on exit.
      this.getView().addEventDelegate({ onExit: this._teardown.bind(this) });
    },

    onExit: function () {
      this._teardown();
    },

    _teardown: function () {
      if (this._typingStopTimer) { clearTimeout(this._typingStopTimer); }
      if (this._video) { this._video.hangup(); this._video = null; }
      if (this._transport) {
        this._transport.disconnect();
        this._transport = null;
      }
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
        onOpen: function () { that._setConn("online"); },
        onClose: function () { that._setConn("offline"); },
        onMessage: function (m) { that._onIncoming(m); },
        onPresence: function (p) { that._onPresence(p); },
        onTyping: function (b) { that._onPeerTyping(b); },
        onSignal: function (sig) { that._onSignal(sig); }
      });
      this._transport.connect();
    },

    /**
     * Dispatcher (or tester) manually binds a Service Call / Activity id.
     */
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

      // Append the transport kind so it's unambiguous what's actually in use,
      // visible even when connected. "Online · relay" = cross-device works;
      // "Online · local" = same-machine only (relay not in use).
      var sText = cfg.text;
      if (sState === "online" && this._transport &&
          typeof this._transport.kind === "function") {
        sText = cfg.text + " \u00b7 " + this._transport.kind();
      }
      oCtx.setProperty("/_connText", sText);
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
      aMessages.push({
        msgId: oMsg.msgId,
        text: oMsg.text,
        senderName: oMsg.senderName || oMsg.userName || "?",
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
        var oScroll = that.byId("msgScroll");
        var oCont = that.byId("msgContainer");
        if (oScroll && oCont) {
          var oDom = oCont.getDomRef();
          if (oDom) {
            oScroll.scrollTo(0, oDom.scrollHeight + 200, 200);
          }
        }
      }, 80);
    }
  });
});
