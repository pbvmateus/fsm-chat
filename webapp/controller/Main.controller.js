sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "com/test/fsmchat/model/ChatTransport"
], function (Controller, JSONModel, ChatTransport) {
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
        manualId: ""
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

      this._setConn("connecting");

      var that = this;
      this._transport = ChatTransport.create(oOpts, {
        onOpen: function () { that._setConn("online"); },
        onClose: function () { that._setConn("offline"); },
        onMessage: function (m) { that._onIncoming(m); },
        onPresence: function (p) { that._onPresence(p); },
        onTyping: function (b) { that._onPeerTyping(b); }
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
