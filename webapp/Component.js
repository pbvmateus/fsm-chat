sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel",
  "sap/ui/Device"
], function (UIComponent, JSONModel, Device) {
  "use strict";

  return UIComponent.extend("com.test.fsmchat.Component", {
    metadata: {
      manifest: "json"
    },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

      // Device model (used for responsive behaviour: mobile vs shell)
      this.setModel(new JSONModel(Device), "device");

      // Resolve FSM context (user, role, object id) from component data,
      // URL params, or the FSM shell SDK if present.
      var oContext = this._resolveFsmContext();
      this.setModel(new JSONModel(oContext), "context");

      this.getRouter().initialize();
    },

    /**
     * Determine who is using the app and in which client.
     * FSM passes context via the extension SDK (window.SAP_FSM_SHELL_SDK)
     * or via URL parameters when launched as a screen extension.
     */
    _resolveFsmContext: function () {
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

      // Detect client: shell SDK exposes a context object; mobile injects
      // a bridge. Fall back to URL param, then to device heuristics.
      var sClient = pick("client", null);
      if (!sClient) {
        if (window.SAP_FSM_SHELL_SDK) {
          sClient = "SHELL";
        } else if (window.FSM_MOBILE_BRIDGE || Device.system.phone) {
          sClient = "MOBILE";
        } else {
          sClient = "SHELL";
        }
      }

      var sRole = pick("role", sClient === "MOBILE" ? "technician" : "dispatcher");
      var sUserId = pick("userId", null);
      var sUserName = pick("userName", null);

      // Try the FSM shell SDK for richer identity when available.
      if (!sUserName && window.SAP_FSM_SHELL_SDK) {
        try {
          var oCtx = window.SAP_FSM_SHELL_SDK.getContext &&
            window.SAP_FSM_SHELL_SDK.getContext();
          if (oCtx && oCtx.user) {
            sUserId = sUserId || oCtx.user.id;
            sUserName = oCtx.user.firstName
              ? (oCtx.user.firstName + " " + (oCtx.user.lastName || "")).trim()
              : oCtx.user.userName;
          }
        } catch (e) {
          // SDK present but context unavailable — keep fallbacks.
        }
      }

      if (!sUserId) {
        sUserId = "u-" + Math.random().toString(36).slice(2, 8);
      }
      if (!sUserName) {
        sUserName = sRole === "technician" ? "Technician" : "Dispatcher";
      }

      // The conversation is keyed by the FSM object (e.g. a Service Call).
      // Both clients open the same object => same room => same chat thread.
      var sObjectId = pick("objectId",
        pick("serviceCallId", pick("activityId", "GENERAL")));

      return {
        client: sClient,
        role: sRole,
        userId: sUserId,
        userName: sUserName,
        objectId: sObjectId,
        roomId: "fsm-room-" + sObjectId
      };
    }
  });
});
