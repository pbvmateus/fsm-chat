sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "com/test/fsmchat/model/ChatTransport"
], function (Controller, JSONModel, MessageToast, ChatTransport) {
  "use strict";

  return Controller.extend("com.test.fsmchat.controller.DirectChat", {

    onInit: function () {
      var oComponent = this.getOwnerComponent();
      this._ctxModel = oComponent.getModel("context");

      this._model = new JSONModel({
        activeTab: "broadcasts",
        broadcasts: [],
        broadcastCount: 0,
        directMessages: [],
        directDraft: ""
      });
      this.getView().setModel(this._model);
      this.getView().setModel(this._ctxModel, "context");
      this.getView().setModel(
        oComponent.getModel("i18n"), "i18n");

      // Share broadcasts from the main model (updated by Main controller).
      this._syncBroadcastsFromApp();

      // Connect direct chat. If userId isn't available yet (shell context
      // hasn't arrived), retry briefly — it arrives within ~500ms.
      var sUserId = this._ctxModel.getProperty("/userId");
      if (sUserId) {
        this._connectDirect();
      } else {
        var that = this;
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

      // Listen for new broadcasts pushed by the app.
      this.getOwnerComponent().attachEvent(
        "broadcastReceived", this._onBroadcastEvent.bind(this));
    },

    // Pull existing broadcasts from the shared app model.
    _syncBroadcastsFromApp: function () {
      var oAppModel = this.getOwnerComponent().getModel("app");
      if (oAppModel) {
        var aBC = oAppModel.getProperty("/broadcasts") || [];
        this._model.setProperty("/broadcasts", aBC.slice());
        this._model.setProperty("/broadcastCount", aBC.length);
      }
    },

    _onBroadcastEvent: function (oEvent) {
      var oMsg = oEvent.getParameter("message");
      if (!oMsg) { return; }
      var aBC = this._model.getProperty("/broadcasts") || [];
      aBC = [oMsg].concat(aBC);
      this._model.setProperty("/broadcasts", aBC);
      this._model.setProperty("/broadcastCount", aBC.length);
    },

    _connectDirect: function () {
      if (this._transport) { return; }
      var sUserId = this._ctxModel.getProperty("/userId");
      var sUserName = this._ctxModel.getProperty("/userName");
      var sRole = this._ctxModel.getProperty("/role");
      var sDirectRoom = "fsm-direct-" + sUserId;

      var oOpts = {
        roomId: sDirectRoom,
        userId: sUserId,
        userName: sUserName,
        role: sRole
      };
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
        },
        onMessage: function (m) { that._onDirectIncoming(m); },
        onDirectChat: function (m) { that._onDirectIncoming(m); },
        onPresence: function () {},
        onTyping: function () {},
        onSignal: function () {},
        onGenericMessage: function () {},
        onGenericBacklog: function () {},
        onGenericClaimed: function () {},
        onBroadcastReceived: function (m) { that._onBroadcastEvent(
          { getParameter: function (k) { return k === "message" ? m : null; } }); },
        onFsmRoster: function () {}
      });
      this._transport.connect();
    },

    _onDirectIncoming: function (oMsg) {
      if (!oMsg || !oMsg.text) { return; }
      var sMyId = this._ctxModel.getProperty("/userId");
      var bMine = oMsg.userId === sMyId;
      var oDate = oMsg.ts ? new Date(oMsg.ts) : new Date();
      var oBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
      var sRoleLabel = oMsg.role === "dispatcher"
        ? oBundle.getText("roleDispatcher")
        : (oMsg.role === "technician" ? oBundle.getText("roleTechnician") : "");
      var aMessages = this._model.getProperty("/directMessages") || [];
      aMessages.push({
        text: oMsg.text,
        senderName: oMsg.userName || oMsg.senderName || "?",
        senderRole: sRoleLabel,
        mine: bMine ? "mine" : "theirs",
        time: oDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
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

    onTabSelect: function (oEvent) {
      var sKey = oEvent.getParameter("key");
      this._model.setProperty("/activeTab", sKey);
    },

    onDirectSend: function () {
      var sText = (this._model.getProperty("/directDraft") || "").trim();
      if (!sText) { return; }
      if (!this._transport) { MessageToast.show("Not connected."); return; }
      var sUserId = this._ctxModel.getProperty("/userId");
      var sRoom = "fsm-direct-" + sUserId;
      // Add message to local list immediately (optimistic).
      var oDate = new Date();
      var aMessages = this._model.getProperty("/directMessages") || [];
      aMessages.push({
        text: sText,
        senderName: this._ctxModel.getProperty("/userName") || "Me",
        senderRole: "",
        mine: "mine",
        time: oDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      });
      this._model.setProperty("/directMessages", aMessages);
      this._model.setProperty("/directDraft", "");
      if (typeof this._transport.sendDirectChat === "function") {
        this._transport.sendDirectChat(sText, sRoom);
      } else {
        // Fallback: send as a regular chat message.
        this._transport.send({ type: "direct-chat", text: sText,
          roomId: sRoom, userName: this._ctxModel.getProperty("/userName"),
          userId: this._ctxModel.getProperty("/userId"), role: "technician" });
      }
      setTimeout(this._scrollToBottom.bind(this), 80);
    },

    onNavBack: function () {
      var oHistory = sap.ui.core.routing.History.getInstance();
      var sPreviousHash = oHistory.getPreviousHash();
      if (sPreviousHash !== undefined) {
        window.history.go(-1);
      } else {
        this.getOwnerComponent().getRouter().navTo("main");
      }
    },

    onExit: function () {
      if (this._transport) {
        this._transport.disconnect();
        this._transport = null;
      }
      this.getOwnerComponent().detachEvent(
        "broadcastReceived", this._onBroadcastEvent.bind(this));
    }
  });
});
