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
      var that = this;
      this._ctxModel = oComponent.getModel("context");

      this._model = new JSONModel({
        activeTab: "broadcasts",
        broadcasts: [],        // [{text, senderName, ts, read}]
        unreadCount: 0,        // unread broadcast count shown in the tab badge
        directMessages: [],
        directDraft: ""
      });
      this.getView().setModel(this._model);
      this.getView().setModel(this._ctxModel, "context");
      this.getView().setModel(oComponent.getModel("i18n"), "i18n");

      // Load broadcasts accumulated by the bg transport before this screen opened.
      this._syncBroadcastsFromApp();

      // Connect direct chat transport (with identity retry).
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

      // Listen for events from the Component background transport.
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

      // If the broadcasts tab is the first thing shown, mark as read immediately.
      if (this._model.getProperty("/activeTab") === "broadcasts") {
        setTimeout(this._markBroadcastsRead.bind(this), 300);
      }
    },

    // ── Broadcast helpers ──────────────────────────────────────────────────

    _syncBroadcastsFromApp: function () {
      var oComponent = this.getOwnerComponent();
      var aBC = oComponent.getBgBroadcasts ? oComponent.getBgBroadcasts() : [];
      if (!aBC.length) {
        var oAppModel = oComponent.getModel("app");
        if (oAppModel) { aBC = oAppModel.getProperty("/broadcasts") || []; }
      }
      this._loadBroadcasts(aBC);
    },

    // Central method to load/merge a broadcast list, preserving read state.
    _loadBroadcasts: function (aItems) {
      if (!aItems || !aItems.length) { return; }
      var aExisting = this._model.getProperty("/broadcasts") || [];
      // Build a dedup set from existing items.
      var oKeys = {};
      aExisting.forEach(function (m) { oKeys[m.ts + "|" + m.text] = true; });

      var bBroadcastTabActive = this._model.getProperty("/activeTab") === "broadcasts";
      var nNewUnread = 0;
      var aNew = [];
      aItems.forEach(function (m) {
        var sKey = (m.ts || "") + "|" + m.text;
        if (oKeys[sKey]) { return; } // already present
        oKeys[sKey] = true;
        var bRead = bBroadcastTabActive ? true : !!m.read;
        if (!bRead) { nNewUnread++; }
        aNew.push({
          text: m.text,
          senderName: m.senderName || "Dispatcher",
          ts: m.ts || new Date().toISOString(),
          read: bRead
        });
      });
      if (!aNew.length) { return; }

      // Prepend new items, then sort newest-first so the order is always consistent.
      var aMerged = aNew.concat(aExisting);
      aMerged.sort(function (a, b) {
        return (new Date(b.ts || 0).getTime()) - (new Date(a.ts || 0).getTime());
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
      // Record when the user cleared so history replay skips older messages.
      oComp._bgClearedAt = Date.now();
    },

    // ── Tab selection ──────────────────────────────────────────────────────

    onTabSelect: function (oEvent) {
      var sKey = oEvent.getParameter("key");
      this._model.setProperty("/activeTab", sKey);
      if (sKey === "broadcasts") {
        // Mark all as read when the user views the broadcasts tab.
        setTimeout(this._markBroadcastsRead.bind(this), 200);
      }
    },

    // ── Direct chat ────────────────────────────────────────────────────────

    _connectDirect: function () {
      if (this._transport) { return; }
      var sUserId = this._ctxModel.getProperty("/userId");
      var sUserName = this._ctxModel.getProperty("/userName");
      var sRole = this._ctxModel.getProperty("/role");
      var sUserKey = (sUserName || sUserId || "unknown").toLowerCase();
      var sDirectRoom = "fsm-direct-" + sUserKey;
      this._directRoom = sDirectRoom;

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
        onBroadcastReceived: function (m) {
          that._onBroadcastEvent({
            getParameter: function (k) { return k === "message" ? m : null; }
          });
        },
        onBroadcastHistory: function (data) {
          var items = (data && data.items) || [];
          if (items.length) { that._loadBroadcasts(items); }
        },
        onPresence: function () {},
        onTyping: function () {},
        onSignal: function () {},
        onGenericMessage: function () {},
        onGenericBacklog: function () {},
        onGenericClaimed: function () {},
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
        time: oDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      });
      this._model.setProperty("/directMessages", aMessages);
      this._model.setProperty("/directDraft", "");
      if (typeof this._transport.sendDirectChat === "function") {
        this._transport.sendDirectChat(sText, this._directRoom);
      }
      setTimeout(this._scrollToBottom.bind(this), 80);
    },

    onNavBack: function () {
      // When opened via screen=direct (/mobile container), there is no
      // meaningful "main" route to go back to — it would show the activity
      // chat's unbound "Select a Service Call" screen. Instead, go back in
      // browser history which lets FSM handle the navigation (closes the
      // container and returns to the FSM screen the technician came from).
      var sScreen = new URLSearchParams(window.location.search).get("screen");
      if (sScreen === "direct") {
        try { window.history.back(); } catch (e) { /* noop */ }
        return;
      }
      var oHistory = sap.ui.core.routing.History.getInstance();
      if (oHistory.getPreviousHash() !== undefined) {
        window.history.go(-1);
      } else {
        // No history — stay on this screen rather than showing the wrong page.
        // (Nothing to do.)
      }
    },

    onExit: function () {
      if (this._transport) { this._transport.disconnect(); this._transport = null; }
      var oComp = this.getOwnerComponent();
      if (this._onBroadcastBound) oComp.detachEvent("broadcastReceived", this._onBroadcastBound);
      if (this._onDirectBound)    oComp.detachEvent("directChatReceived", this._onDirectBound);
      if (this._onHistoryBound)   oComp.detachEvent("broadcastHistoryLoaded", this._onHistoryBound);
    }
  });
});
