sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "com/test/fsmchat/model/ChatTransport"
], function (Controller, JSONModel, ChatTransport) {
  "use strict";

  return Controller.extend("com.test.fsmchat.controller.Main", {

    onInit: function () {
      var oComponent = this.getOwnerComponent();
      this._ctx = oComponent.getModel("context").getData();

      // View-local data model.
      this._model = new JSONModel({
        messages: [],
        draft: "",
        peerTyping: false
      });
      this.getView().setModel(this._model);

      // Decorate the context model with display helpers.
      var oCtxModel = oComponent.getModel("context");
      var peerRole = this._ctx.role === "technician" ? "dispatcher" : "technician";
      var oBundle = oComponent.getModel("i18n").getResourceBundle();
      oCtxModel.setProperty("/_peerRole", peerRole);
      oCtxModel.setProperty("/_peerName", oBundle.getText(
        peerRole === "dispatcher" ? "roleDispatcher" : "roleTechnician"));
      oCtxModel.setProperty("/_peerLabel", oBundle.getText("youAre", [
        oBundle.getText(this._ctx.role === "technician"
          ? "roleTechnician" : "roleDispatcher"),
        oCtxModel.getProperty("/_peerName")
      ]));
      this.getView().setModel(oCtxModel, "context");

      this._setConn("connecting");

      // Build transport and connect.
      var that = this;
      this._transport = ChatTransport.create(this._ctx, {
        onOpen: function () { that._setConn("online"); },
        onClose: function () { that._setConn("offline"); },
        onMessage: function (m) { that._onIncoming(m); },
        onPresence: function (p) { that._onPresence(p); },
        onTyping: function (b) { that._onPeerTyping(b); }
      });
      this._transport.connect();

      // Clean up on exit.
      this.getView().addEventDelegate({
        onExit: this._teardown.bind(this)
      });
    },

    onExit: function () {
      this._teardown();
    },

    _teardown: function () {
      if (this._typingStopTimer) { clearTimeout(this._typingStopTimer); }
      if (this._transport) { this._transport.disconnect(); }
    },

    _setConn: function (sState) {
      var oCtx = this.getView().getModel("context");
      var oBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
      var map = {
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
      var that = this;
      this._transport.sendTyping(true);
      if (this._typingStopTimer) { clearTimeout(this._typingStopTimer); }
      this._typingStopTimer = setTimeout(function () {
        that._transport.sendTyping(false);
      }, 1500);
    },

    onSend: function () {
      var sText = (this._model.getProperty("/draft") || "").trim();
      if (!sText) { return; }

      var oMsg = {
        msgId: this._ctx.userId + "-" + Date.now() + "-" +
          Math.random().toString(36).slice(2, 6),
        userId: this._ctx.userId,
        senderName: this._ctx.userName,
        role: this._ctx.role,
        text: sText,
        ts: ChatTransport.nowISO()
      };

      // Render locally immediately (own message).
      this._appendMessage(oMsg, true);

      // Broadcast.
      this._transport.send(oMsg);
      this._transport.sendTyping(false);

      // Reset composer.
      this._model.setProperty("/draft", "");
    },

    _onIncoming: function (oMsg) {
      // Skip our own echoed messages (transport may rebroadcast).
      if (oMsg.userId === this._ctx.userId) {
        var existing = this._model.getProperty("/messages")
          .some(function (m) { return m.msgId === oMsg.msgId; });
        if (existing) { return; }
      }
      this._appendMessage(oMsg, oMsg.userId === this._ctx.userId);
      this._onPeerTyping(false);
    },

    _appendMessage: function (oMsg, bMine) {
      var aMessages = this._model.getProperty("/messages");
      // De-dupe by msgId.
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
      if (oP.userId && oP.userId !== this._ctx.userId) {
        // A peer joined — make sure we show online.
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
