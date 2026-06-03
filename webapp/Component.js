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

      // Kick off async Shell resolution (no-op when running standalone).
      this._resolveViaShell();
    },

    exit: function () {
      if (this._shell && typeof this._shell.destroy === "function") {
        this._shell.destroy();
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
        { clientIdentifier: "fsm-chat-extension", debug: bDebug },
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
      var oModel = this._contextModel;
      var sRoom = "fsm-room-" + sActivityId;
      oModel.setProperty("/objectId", String(sActivityId));
      oModel.setProperty("/roomId", sRoom);
      oModel.setProperty("/_bound", true);
      oModel.setProperty("/_contextSource", sSource || "manual");

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
    }
  });
});
