// Load the SAP fsm-shell client library as an AMD module named
// "fsm-shell-client". Pinned to a specific version for reproducibility.
// When this loads, it exposes window.FSMShell ({ ShellSdk, SHELL_EVENTS }).
sap.ui.loader.config({
  paths: {
    "fsm-shell-client": "https://unpkg.com/fsm-shell@1.20.0/release/fsm-shell-client"
  },
  shim: {
    "fsm-shell-client": {
      amd: true,
      exports: "FSMShell"
    }
  }
});

sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel",
  "sap/ui/Device",
  "com/test/fsmchat/model/FsmShell",
  "fsm-shell-client"
], function (UIComponent, JSONModel, Device, FsmShell, FSMShellLib) {
  "use strict";

  // Ensure the library is reachable as a global for FsmShell.js, regardless
  // of how the AMD shim resolved it.
  if (FSMShellLib && !window.FSMShell) {
    window.FSMShell = FSMShellLib;
  }

  return UIComponent.extend("com.test.fsmchat.Component", {
    metadata: {
      manifest: "json",
      events: {
        activityBound: {}
      }
    },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
      this.setModel(new JSONModel(Device), "device");

      // Seed context from URL / startup params synchronously so the UI can
      // render immediately; Shell-derived values fill in asynchronously.
      var oSeed = this._seedContext();
      var oContextModel = new JSONModel(oSeed);
      this.setModel(oContextModel, "context");
      this._contextModel = oContextModel;

      this.getRouter().initialize();

      // If the URL carries screen=direct (set by the /mobile Cloudflare function
      // for the standalone technician Dispatcher Channel container), navigate
      // straight to the DirectChat view without showing the main activity chat.
      var sScreen = new URLSearchParams(window.location.search).get("screen");
      if (sScreen === "direct") {
        // Also carry over userId/userName from URL into the context model so
        // the DirectChat controller has identity even before Shell context arrives.
        var sUrlUserId = new URLSearchParams(window.location.search).get("userId");
        var sUrlUserName = new URLSearchParams(window.location.search).get("userName");
        if (sUrlUserId) oContextModel.setProperty("/userId", sUrlUserId);
        if (sUrlUserName) oContextModel.setProperty("/userName", decodeURIComponent(sUrlUserName));
        // Navigate after a microtask so the router is ready.
        setTimeout(function () {
          this.getRouter().navTo("directchat", {}, true);
        }.bind(this), 0);
      }
      this._resolveViaShell();
      // Start the background transport for the technician after identity
      // is available (needed for the personal room key).
      this._startBgTransport();
    },

    // Persistent background transport for the technician — connected to their
    // fsm-user-<userName> personal room so broadcasts and direct messages
    // arrive even when the activity chat or DirectChat screen isn't open.
    // Uses a short retry loop since identity (userName) may arrive async.
    _startBgTransport: function () {
      var oModel = this._contextModel;
      var sRole = oModel.getProperty("/role");
      if (sRole !== "technician") { return; } // dispatchers don't need this
      var that = this;
      var nAttempts = 0;
      var oRetry = setInterval(function () {
        nAttempts++;
        var sUserName = oModel.getProperty("/userName");
        if (sUserName || nAttempts >= 30) {
          clearInterval(oRetry);
          if (!sUserName) { return; }
          that._initBgTransport(sUserName);
        }
      }, 200);
    },

    _initBgTransport: function (sUserName) {
      if (this._bgTransport) { return; } // already running
      var oModel = this._contextModel;
      var sUserKey = sUserName.toLowerCase();
      // Connect to the personal room — the relay auto-joins fsm-user-<key>
      // and fsm-direct-<key> when the technician sends a join message here.
      var oOpts = {
        roomId: "fsm-user-" + sUserKey,
        userId: oModel.getProperty("/userId"),
        userName: sUserName,
        role: "technician"
      };
      var that = this;
      // Lazy-load ChatTransport.
      sap.ui.require(["com/test/fsmchat/model/ChatTransport"], function (ChatTransport) {
        that._bgTransport = ChatTransport.create(oOpts, {
          onOpen: function () { /* background, no UI feedback needed */ },
          onClose: function () {
            // Reconnect after a delay if closed unexpectedly.
            setTimeout(function () {
              if (that._bgTransport) {
                that._bgTransport = null;
                that._initBgTransport(sUserName);
              }
            }, 5000);
          },
          onBroadcastReceived: function (m) {
            // Fire a component event so any open controller can react.
            that.fireEvent("broadcastReceived", { message: m });
            // Also store in a persistent broadcasts list on the component.
            that._bgBroadcasts = that._bgBroadcasts || [];
            that._bgBroadcasts.unshift({
              text: m.text,
              senderName: m.senderName || "Dispatcher",
              ts: m.ts || new Date().toISOString()
            });
            // Play a beep — the user may be on any screen.
            that._bgBeep();
          },
          onDirectChat: function (m) {
            that.fireEvent("directChatReceived", { message: m });
          },
          onMessage: function () {},
          onPresence: function () {},
          onTyping: function () {},
          onSignal: function () {},
          onGenericMessage: function () {},
          onGenericBacklog: function () {},
          onGenericClaimed: function () {},
          onFsmRoster: function () {}
        });
        that._bgTransport.connect();
      });
    },

    _bgBeep: function () {
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { return; }
        if (!this._bgAudioCtx) { this._bgAudioCtx = new AC(); }
        var ctx = this._bgAudioCtx;
        if (ctx.state === "suspended" && ctx.resume) { ctx.resume(); }
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = "sine"; osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 0.36);
      } catch (e) { /* noop */ }
    },

    getBgBroadcasts: function () {
      return (this._bgBroadcasts || []).slice();
    },

    exit: function () {
      if (this._shell && typeof this._shell.destroy === "function") {
        this._shell.destroy();
      }
      if (this._bgTransport) {
        this._bgTransport.disconnect();
        this._bgTransport = null;
      }
    },

    /**
     * Synchronous best-effort context from URL params / FLP startup params.
     * Establishes role, client, identity fallbacks, and an initial room.
     */
    _seedContext: function () {
      var oComponentData = this.getComponentData() || {};
      var oStartupParams = (oComponentData.startupParameters) || {};
      var oUrlParams = new URLSearchParams(window.location.search);

      function pick(key, fallback) {
        if (oStartupParams[key] && oStartupParams[key][0]) {
          return oStartupParams[key][0];
        }
        if (oUrlParams.get(key)) {
          return oUrlParams.get(key);
        }
        return fallback;
      }

      var bFramed = window.parent && window.parent !== window;
      var sClient = pick("client", null);
      if (!sClient) {
        sClient = (Device.system.phone && !bFramed) ? "MOBILE" : "SHELL";
      }

      var sRole = pick("role", sClient === "MOBILE" ? "technician" : "dispatcher");

      var sUserId = pick("userId", "u-" + Math.random().toString(36).slice(2, 8));
      var sUserName = pick("userName",
        sRole === "technician" ? "Technician" : "Dispatcher");

      // Activity / Service Call id may come from a launch parameter. If not,
      // it stays empty and the user binds it manually (or the Shell supplies
      // it asynchronously).
      var sObjectId = pick("objectId",
        pick("serviceCallId", pick("activityId", "")));
      // Normalize case: FSM delivers the activity guid in different cases via
      // different channels (mobile cloudId is lowercase, shell SET_VIEW_STATE
      // is uppercase). The room is derived from this id, so without
      // normalization the two sides compute DIFFERENT rooms and never meet on
      // the relay. Uppercase is canonical for these hex guids.
      if (sObjectId) { sObjectId = String(sObjectId).toUpperCase(); }

      var bDebug = pick("debug", "") === "1" || pick("debug", "") === "true";

      return {
        client: sClient,
        role: sRole,
        userId: sUserId,
        userName: sUserName,
        objectId: sObjectId,
        roomId: sObjectId ? "fsm-room-" + sObjectId : "",
        companyId: "",
        outlet: "",
        // UI state flags
        _bound: !!sObjectId,
        _contextSource: sObjectId ? "param" : "none",
        _shellReady: false,
        _debug: bDebug,
        _debugLog: ""
      };
    },

    /**
     * Asynchronously enrich context from the FSM Shell SDK:
     *   - real user identity (user, userId)
     *   - selected activity id (best-effort; see FsmShell.js caveats)
     */
    _resolveViaShell: function () {
      var that = this;
      var oModel = this._contextModel;
      var bDebug = oModel.getProperty("/_debug");

      this._shell = new FsmShell();

      // In debug mode, surface the raw log even if we're "not in Shell",
      // so the user can see WHY (e.g. isAvailable=false).
      if (bDebug) {
        this._shell.onDebug(function (aLines) {
          oModel.setProperty("/_debugLog", aLines.join("\n"));
        });
      }

      // Arm the Shell integration whenever we're inside an iframe (i.e.
      // embedded in FSM). The selection listener does NOT require the fsm-shell
      // SDK library to have loaded, so we must NOT gate init() on isAvailable().
      // Only skip when genuinely standalone (opened directly, not framed).
      var bFramed = window.parent && window.parent !== window;
      if (!bFramed && !bDebug) {
        // Standalone (e.g. GitHub Pages opened directly) — nothing to wire.
        return;
      }

      this._shell.init(
        {
          clientIdentifier: "fsm-chat-extension",
          debug: bDebug,
          // onToken is called by FsmShell when REQUIRE_AUTHENTICATION returns a
          // token (and again on proactive/reactive refresh). Store the token and
          // schedule a proactive refresh 30s before it expires.
          onToken: function (sToken, nExpiresIn) {
            oModel.setProperty("/fsmToken", sToken);
            // Schedule proactive refresh.
            if (that._tokenRefreshTimer) { clearTimeout(that._tokenRefreshTimer); }
            var refreshIn = Math.max(((nExpiresIn || 300) - 30) * 1000, 10000);
            that._tokenRefreshTimer = setTimeout(function () {
              if (that._shell && typeof that._shell.refreshToken === "function") {
                that._shell.refreshToken();
              }
            }, refreshIn);
          }
        },
        function onContext(ctx) {
          oModel.setProperty("/_shellReady", true);
          if (!ctx) { return; }

          // Identity: prefer real Shell user over the placeholder.
          if (ctx.user) {
            oModel.setProperty("/userName", ctx.user);
          }
          if (ctx.userId) {
            oModel.setProperty("/userId", ctx.userId);
          }
          // Stash company/account for potential room namespacing.
          if (ctx.companyId) {
            oModel.setProperty("/companyId", ctx.companyId);
          }
          if (ctx.targetOutletName) {
            oModel.setProperty("/outlet", ctx.targetOutletName);
          }
          // Capture FSM env context for Data API calls.
          // cloudHost is the bare hostname (e.g. "us.fsm.cloud.sap"), used
          // as clusterHost in API calls — matching the confirmed fsm-api.js.
          var sAccount = ctx.account || ctx.cloudAccount || null;
          var sCompany = ctx.company || ctx.companyName || null;
          var sHost = ctx.cloudHost || null;  // bare hostname, no https://
          // Token may arrive in context on some shell versions; FsmShell's
          // onToken callback via REQUIRE_AUTHENTICATION is the primary path.
          var sToken = (ctx.auth && ctx.auth.access_token) || ctx.authToken || null;
          if (sAccount) oModel.setProperty("/fsmAccount", sAccount);
          if (sCompany) oModel.setProperty("/fsmCompany", sCompany);
          if (sHost) oModel.setProperty("/fsmHost", sHost);
          if (sToken) oModel.setProperty("/fsmToken", sToken);
          // Store the raw auth object for diagnostics.
          oModel.setProperty("/fsmAuthRaw", JSON.stringify(ctx.auth || null));
        },
        function onSelection(activityId) {
          // The Shell told us which Service Call / Activity is selected.
          that._bindToActivity(activityId, "shell");
        }
      );
    },

    /**
     * Bind the chat to a specific activity id, recomputing the room.
     * Called either from the Shell selection callback or from the UI when
     * the user enters an id manually.
     *
     * @param {string} sActivityId
     * @param {string} sSource  "shell" | "manual" | "param"
     */
    _bindToActivity: function (sActivityId, sSource) {
      if (!sActivityId) { return; }
      // Normalize case so shell (uppercase SET_VIEW_STATE) and mobile
      // (lowercase cloudId) compute the SAME room for the same activity.
      sActivityId = String(sActivityId).toUpperCase();
      var oModel = this._contextModel;
      var sRoom = "fsm-room-" + sActivityId;
      oModel.setProperty("/objectId", String(sActivityId));
      oModel.setProperty("/roomId", sRoom);
      oModel.setProperty("/_bound", true);
      oModel.setProperty("/_contextSource", sSource || "manual");

      // DEBUG: confirm the Component received the selection and flipped the
      // flag. If you see this line but the panel stays, the view is bound to a
      // different model instance than the one being mutated here.
      if (oModel.getProperty("/_debug")) {
        var prev = oModel.getProperty("/_debugLog") || "";
        oModel.setProperty("/_debugLog",
          prev + "\n  -> Component bound room=" + sRoom +
          " (_bound=" + oModel.getProperty("/_bound") + ", src=" +
          (sSource || "manual") + ")");
      }

      // Notify the running controller so it can (re)connect the transport.
      this.fireEvent("activityBound", { roomId: sRoom });
    },

    /**
     * Public helper used by the Main controller to register a listener for
     * room (re)binding without tightly coupling to the component internals.
     */
    onActivityBound: function (fn) {
      this.attachEvent("activityBound", function (oEvt) {
        fn(oEvt.getParameter("roomId"));
      });
    },

    /**
     * Public: bind manually from the UI (dispatcher pastes a Service Call id).
     */
    bindActivityManually: function (sActivityId) {
      this._bindToActivity(sActivityId, "manual");
    },

    // Shared broadcast store — allows DirectChat controller to read broadcasts
    // that arrived via Main controller's _onBroadcastReceived.
    getBroadcasts: function () { return this._broadcasts || []; },
    setBroadcasts: function (a) { this._broadcasts = a; },
    onBroadcastReceived: function (fn) {
      if (!this._broadcastListeners) { this._broadcastListeners = []; }
      this._broadcastListeners.push(fn);
    },
    fireBroadcastReceived: function (oMsg) {
      if (!this._broadcastListeners) { return; }
      this._broadcastListeners.forEach(function (fn) { try { fn(oMsg); } catch (e) {} });
    },

    /**
     * Public: dispatcher leaves the current activity and returns to the unbound
     * (generic inbox) state. Clears the bound flag/room so the view shows the
     * inbox again; the controller drops the activity room on the relay, which
     * makes the activity "unattended" again if no other dispatcher remains.
     */
    unbindActivity: function () {
      var oModel = this._contextModel;
      oModel.setProperty("/_bound", false);
      oModel.setProperty("/roomId", "");
      oModel.setProperty("/objectId", "");
      oModel.setProperty("/_contextSource", "");
      this.fireEvent("activityUnbound", {});
    },

    onActivityUnbound: function (fn) {
      this.attachEvent("activityUnbound", function () { fn(); });
    }
  });
});
