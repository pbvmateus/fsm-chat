sap.ui.define([], function () {
  "use strict";

  /**
   * FsmShell — thin wrapper around SAP's fsm-shell client library.
   *
   * Reference: https://github.com/SAP/fsm-shell (docs/events.md, usage-sample.md)
   *
   * Responsibilities:
   *   1. Detect whether we are running inside the FSM Shell at all.
   *   2. Emit REQUIRE_CONTEXT and resolve the user/company/account context.
   *      (This is the SUPPORTED way to get identity. It does NOT include the
   *       selected activity — see note below.)
   *   3. DEFENSIVELY try to obtain the currently-selected Service Call /
   *      Activity id. SAP's documented ViewState channel (onViewState) is
   *      restricted for outlet extensions and may throw; some tenants surface
   *      selection another way. We attempt several channels, swallow errors,
   *      and simply report nothing if none deliver — the caller then falls
   *      back to a manual / URL-provided activity id.
   *
   * The library is loaded via the AMD path "fsm-shell-client" configured in
   * Component.js. If it isn't present (e.g. running standalone on GitHub
   * Pages), every method degrades gracefully.
   */

  function FsmShell() {
    this._sdk = null;
    this._SHELL_EVENTS = null;
    this._inited = false;
    this._selectionCallback = null;
    this._lastSelectedId = null;
  }

  /**
   * @returns {boolean} true if the fsm-shell library is loaded AND we appear
   * to be embedded in the Shell host (inside an iframe under FSM).
   */
  FsmShell.prototype.isAvailable = function () {
    var FSMShell = window.FSMShell;
    if (!FSMShell || !FSMShell.ShellSdk) {
      return false;
    }
    try {
      // Static helper added by the library; true when rendered in Shell.
      if (typeof FSMShell.ShellSdk.isInsideShell === "function") {
        return FSMShell.ShellSdk.isInsideShell();
      }
    } catch (e) {
      // fall through
    }
    // Fallback heuristic: we are framed.
    return window.parent && window.parent !== window;
  };

  /**
   * Initialise the SDK and request context.
   *
   * @param {object} opts { clientIdentifier }
   * @param {function} onContext called with the resolved context object:
   *        { account, accountId, company, companyId, user, userId,
   *          selectedLocale, targetOutletName }
   * @param {function} [onSelection] called (possibly repeatedly) with a
   *        selected activity/service-call id string when one is detected.
   */
  FsmShell.prototype.init = function (opts, onContext, onSelection) {
    this._selectionCallback = onSelection || null;
    this._debug = !!(opts && opts.debug);
    this._rawLog = [];
    var that = this;

    // Build marker — lets us confirm which bundle is actually live. If you do
    // NOT see this line in the debug box, you are running a stale/cached build
    // and need to hard-refresh / wait for the GitHub Pages deploy to finish.
    var BUILD = "fsm-chat build mobile-1";
    if (this._debug) {
      this._rawLog.push("=== " + BUILD + " — selection listener arming ===");

      // Environment dump — critical for the MOBILE investigation. The mobile
      // web container may deliver the activity via URL params or a JS bridge
      // rather than postMessage, so record what's present on load.
      try {
        var bF = (window.parent && window.parent !== window);
        this._rawLog.push("env: framed=" + bF +
          " | url=" + (window.location ? window.location.href : "?"));
        // Look for FSM-ish globals a native webview might inject.
        var globals = [];
        ["FSMShell", "FSM_MOBILE_BRIDGE", "SAP_FSM_SHELL_SDK",
         "cordova", "webkit", "ReactNativeWebView", "Android"].forEach(
          function (g) { if (typeof window[g] !== "undefined") { globals.push(g); } });
        this._rawLog.push("globals present: " +
          (globals.length ? globals.join(", ") : "(none)"));
      } catch (envErr) { /* noop */ }
    }

    // DEBUG: capture EVERY message the host posts to this iframe, regardless
    // of whether the SDK library recognises it.
    if (this._debug) {
      var self = this;
      this._rawListener = function (e) {
        var entry;
        try {
          entry = (typeof e.data === "string") ? e.data : JSON.stringify(e.data);
        } catch (x) {
          entry = String(e.data);
        }
        var line = "[" + (e.origin || "?") + "] " + entry;
        self._rawLog.push(line);
        if (self._rawLog.length > 50) { self._rawLog.shift(); }
        window.__FSM_CHAT_RAWLOG__ = self._rawLog;
        if (typeof self._onDebug === "function") {
          self._onDebug(self._rawLog.slice());
        }
        // ALSO run the selection handler here (single proven-firing path).
        // This guarantees that if the raw listener sees the message — which
        // the logs confirm it does — the binding is attempted too.
        self._handleSelectionMessage(e, "debug-raw");
      };
      window.addEventListener("message", this._rawListener, false);
      window.__FSM_CHAT_RAWLOG__ = this._rawLog;
    }

    // --- PRIMARY selection channel (confirmed via live debug capture) ------
    // The dispatching-board activity sidebar pushes the selected activity as a
    // raw postMessage of type "V1.SET_VIEW_STATE" with key "activityID":
    //   {"type":"V1.SET_VIEW_STATE","value":{"key":"activityID","value":"<id>"}}
    // It also emits key "selectedSidebar" -> { id: "ACTIVITY:<id>" }.
    //
    // CRITICAL: this listener is installed UNCONDITIONALLY and does NOT depend
    // on the fsm-shell SDK library being loaded. Selection arrives as a plain
    // window 'message' from the Shell host; gating it behind the SDK (or behind
    // isAvailable()) would silently disable auto-binding whenever the CDN
    // library is slow/blocked. We only need to be inside an iframe.
    this._viewStateListener = function (e) {
      that._handleSelectionMessage(e, "primary");
    };
    // Arm when framed (shell iframe) OR in debug mode. Mobile web containers
    // may load at the top level (not in an iframe); without this, a non-framed
    // webview would silently ignore any selection the mobile host posts. The
    // handler only reacts to SET_VIEW_STATE messages, so arming it broadly is
    // harmless if nothing relevant arrives.
    var bFramed = window.parent && window.parent !== window;
    if (bFramed || this._debug) {
      window.addEventListener("message", this._viewStateListener, false);
      if (this._debug && !bFramed) {
        this._rawLog.push("Top-level (not iframed) — selection listener armed " +
          "anyway for capture. If mobile, watch for any activity-bearing message.");
      }
    }

    // --- SDK init for IDENTITY (separate, allowed to fail independently) ----
    // If the fsm-shell library isn't loaded we skip the SDK handshake but the
    // selection listener above is already armed, so auto-binding still works.
    if (!this.isAvailable()) {
      if (this._debug) {
        this._rawLog.push("isAvailable()=false — fsm-shell SDK not loaded; " +
          "identity will use fallbacks, but activity auto-bind is still active.");
        if (typeof this._onDebug === "function") {
          this._onDebug(this._rawLog.slice());
        }
      }
      // Still report "no context" so identity falls back, but DO NOT return
      // before the selection listener (already installed above).
      onContext && onContext(null);
      return;
    }

    var FSMShell = window.FSMShell;
    var ShellSdk = FSMShell.ShellSdk;
    var SHELL_EVENTS = FSMShell.SHELL_EVENTS;
    this._SHELL_EVENTS = SHELL_EVENTS;

    try {
      this._sdk = ShellSdk.init(window.parent, "*");
      this._inited = true;
    } catch (e) {
      if (this._debug) { this._rawLog.push("ShellSdk.init threw: " + e.message); }
      onContext && onContext(null);
      return;
    }

    // --- 1. Listen for responses BEFORE emitting. ---

    // REQUIRE_CONTEXT: returns cloudHost/account/company/user.
    // For extensions the Shell does NOT return a token here — the token
    // comes separately from REQUIRE_AUTHENTICATION (per confirmed working
    // Custom Objects Manager pattern). Do NOT pass clientSecret or auth
    // in the emit — that is wrong for extensions; it's ignored/harmful.
    var firstContextSeen = false;
    try {
      this._sdk.on(SHELL_EVENTS.Version1.REQUIRE_CONTEXT, function (payload) {
        var ctx = null;
        try {
          ctx = (typeof payload === "string") ? JSON.parse(payload) : payload;
        } catch (parseErr) { ctx = null; }

        if (that._debug) {
          var keys = ctx && typeof ctx === "object"
            ? Object.keys(ctx).join(", ") : "(none)";
          that._rawLog.push("REQUIRE_CONTEXT keys: " + keys);
          if (typeof that._onDebug === "function") {
            that._onDebug(that._rawLog.slice());
          }
        }

        if (!firstContextSeen) {
          firstContextSeen = true;
          // Check if token came with context (some shell versions include it).
          var t = (ctx && ctx.auth && ctx.auth.access_token) ||
                  (ctx && ctx.authToken) || null;
          if (t && typeof opts.onToken === "function") {
            opts.onToken(t, 300);
          }
          onContext && onContext(ctx);
          that._wireSelectionListeners();

          // If no token in context, request it explicitly via REQUIRE_AUTHENTICATION.
          if (!t) {
            if (that._debug) { that._rawLog.push("→ No token in context, emitting REQUIRE_AUTHENTICATION"); }
            try {
              that._sdk.emit(SHELL_EVENTS.Version1.REQUIRE_AUTHENTICATION,
                { response_type: "token" });
            } catch (e) { /* noop */ }
          }
        }

        if (ctx) {
          var sId = that._extractActivityFromContext(ctx);
          if (sId) { that._deliverSelection(sId); }
        }
      });
    } catch (e) {
      onContext && onContext(null);
    }

    // REQUIRE_AUTHENTICATION: returns the access_token for API calls.
    // Also handles proactive and reactive token refresh.
    try {
      this._sdk.on(SHELL_EVENTS.Version1.REQUIRE_AUTHENTICATION, function (auth) {
        if (typeof auth === "string") {
          try { auth = JSON.parse(auth); } catch (e) { /* noop */ }
        }
        var t = (auth && auth.access_token) ||
                (auth && auth.auth && auth.auth.access_token) || null;
        if (t && typeof opts.onToken === "function") {
          var expiresIn = (auth && auth.expires_in) || 300;
          opts.onToken(t, expiresIn);
          if (that._debug) {
            that._rawLog.push("✓ REQUIRE_AUTHENTICATION token (expires_in=" + expiresIn + "s)");
            if (typeof that._onDebug === "function") { that._onDebug(that._rawLog.slice()); }
          }
        } else if (that._debug) {
          that._rawLog.push("✗ REQUIRE_AUTHENTICATION gave no token: " + JSON.stringify(auth));
          if (typeof that._onDebug === "function") { that._onDebug(that._rawLog.slice()); }
        }
      });
    } catch (e) { /* noop */ }

    // Expose a refresh method so the Component can reactively refresh on 401.
    this.refreshToken = function () {
      try {
        that._sdk.emit(SHELL_EVENTS.Version1.REQUIRE_AUTHENTICATION,
          { response_type: "token" });
      } catch (e) { /* noop */ }
    };

    // Surface SDK errors.
    try {
      this._sdk.on(SHELL_EVENTS.ERROR, function () { /* swallow */ });
    } catch (e) { /* noop */ }

    // --- 2. Emit REQUIRE_CONTEXT (clientIdentifier only — no secret, no auth). ---
    try {
      this._sdk.emit(SHELL_EVENTS.Version1.REQUIRE_CONTEXT, {
        clientIdentifier: (opts && opts.clientIdentifier) || "fsm-chat-extension"
      });
    } catch (e) {
      if (!firstContextSeen) { onContext && onContext(null); }
    }

    // Safety: if the host never answers, don't hang forever.
    setTimeout(function () {
      if (!firstContextSeen) {
        firstContextSeen = true;
        onContext && onContext(null);
        that._wireSelectionListeners();
      }
    }, 4000);
  };

  /**
   * Pull a selected activity / service-call id out of a REQUIRE_CONTEXT
   * payload. The dispatching-board outlet exposes the current selection on
   * the context object; observed/ documented shapes include a nested `data`
   * object (event.data.activityId) and top-level selection fields.
   */
  FsmShell.prototype._extractActivityFromContext = function (ctx) {
    if (!ctx || typeof ctx !== "object") { return null; }

    // Initial selection (if any) is carried in the REQUIRE_CONTEXT payload at
    // viewState.selectedSidebar.id, formatted as "ACTIVITY:<id>". At load this
    // is usually "" (nothing selected yet); live changes come via
    // SET_VIEW_STATE (see the window listener in init).
    if (ctx.viewState && ctx.viewState.selectedSidebar &&
        ctx.viewState.selectedSidebar.id) {
      var raw = ctx.viewState.selectedSidebar.id;
      if (typeof raw === "string" && raw.length) {
        var idx = raw.indexOf(":");
        return idx >= 0 ? raw.slice(idx + 1) : raw;
      }
    }
    if (ctx.viewState && ctx.viewState.activityID) {
      return ctx.viewState.activityID;
    }

    // Other observed/documented shapes.
    if (ctx.data) {
      var fromData = this._extractId(ctx.data);
      if (fromData) { return fromData; }
    }
    return ctx.activityId || ctx.serviceCallId || ctx.selectedActivityId ||
      ctx.selectedActivity || ctx.objectId || null;
  };

  /**
   * Parse a raw window 'message' event and, if it is a SET_VIEW_STATE carrying
   * an activity selection, deliver the activity id. Shared by the primary
   * listener and the debug raw listener so there is ONE source of truth.
   *
   * Handles the exact shapes observed on us.fsm.cloud.sap / WFM_ACTIVITY_SIDEBAR:
   *   {"type":"V1.SET_VIEW_STATE","value":{"key":"activityID","value":"<id>"}}
   *   {"type":"V1.SET_VIEW_STATE","value":{"key":"selectedSidebar",
   *      "value":{"eventId":"...","id":"ACTIVITY:<id>"}}}
   */
  FsmShell.prototype._handleSelectionMessage = function (e, source) {
    var data = e && e.data;
    try {
      if (typeof data === "string") { data = JSON.parse(data); }
    } catch (x) { return; }
    if (!data || typeof data !== "object") { return; }

    var type = data.type || "";
    if (type.indexOf("SET_VIEW_STATE") === -1) { return; }

    var payload = data.value || {};
    var key = payload.key;
    var val = payload.value;
    if (val == null) { return; }

    var sId = null;
    if (key === "activityID" || key === "activityId") {
      sId = (typeof val === "string") ? val : this._extractId(val);
    } else if (key === "selectedSidebar") {
      var rawId = (val && val.id) ? val.id : this._extractId(val);
      if (rawId && typeof rawId === "string") {
        var idx = rawId.indexOf(":");
        sId = idx >= 0 ? rawId.slice(idx + 1) : rawId;
      }
    }

    if (sId) {
      if (this._debug) {
        this._rawLog.push("  -> BOUND activity (" + (source || "?") + "): " + sId);
        if (typeof this._onDebug === "function") {
          this._onDebug(this._rawLog.slice());
        }
      }
      this._deliverSelection(sId);
    }
  };

  /**
   * Centralised, de-duplicated delivery of a selected id to the caller.
   */
  FsmShell.prototype._deliverSelection = function (id) {
    if (!id || String(id) === String(this._lastSelectedId)) { return; }
    this._lastSelectedId = id;
    this._selectionCallback && this._selectionCallback(String(id));
  };

  /**
   * Try every plausible channel for "the selected activity".
   * All wrapped defensively; failures are expected and ignored.
   */
  FsmShell.prototype._wireSelectionListeners = function () {
    if (!this._sdk || !this._SHELL_EVENTS) { return; }
    var that = this;
    var SHELL_EVENTS = this._SHELL_EVENTS;

    // (a) ViewState keys. Documented as restricted for extensions (may throw),
    //     but cheap to attempt — some host/version combos still emit these.
    var viewStateKeys = ["ACTIVITY", "SERVICECALL", "SERVICE_CALL",
      "SELECTED_ACTIVITY", "TECHNICIAN", "selectedActivity"];
    if (typeof this._sdk.onViewState === "function") {
      viewStateKeys.forEach(function (key) {
        try {
          that._sdk.onViewState(key, function (val) {
            // val may be an id string or an object holding one.
            that._deliverSelection(that._extractId(val));
          });
        } catch (e) { /* restricted — ignore */ }
      });
    }

    // (b) TO_APP-style inbound messages. Some custom hosts push selection here.
    try {
      this._sdk.on(SHELL_EVENTS.Version1.TO_APP, function (content) {
        if (!content) { return; }
        that._deliverSelection(that._extractId(content));
      });
    } catch (e) { /* noop */ }
  };

  /**
   * Best-effort extraction of an id from a variety of payload shapes.
   */
  FsmShell.prototype._extractId = function (val) {
    if (val == null) { return null; }
    if (typeof val === "string" || typeof val === "number") { return val; }
    if (typeof val === "object") {
      return val.id || val.activityId || val.serviceCallId ||
        val.objectId || val.code || (val.data && this._extractId(val.data)) ||
        null;
    }
    return null;
  };

  /**
   * Remove window listeners. Call on component/controller exit.
   */
  FsmShell.prototype.destroy = function () {
    if (this._viewStateListener) {
      window.removeEventListener("message", this._viewStateListener, false);
      this._viewStateListener = null;
    }
    if (this._rawListener) {
      window.removeEventListener("message", this._rawListener, false);
      this._rawListener = null;
    }
  };

  /**
   * Register a callback to receive the running raw-message debug log.
   * Only meaningful when init was called with { debug: true }.
   */
  FsmShell.prototype.onDebug = function (fn) {
    this._onDebug = fn;
    if (this._rawLog && fn) { fn(this._rawLog.slice()); }
  };

  /**
   * Optionally set the Shell browser title (nice touch for full-screen).
   */
  FsmShell.prototype.setTitle = function (sTitle) {
    if (!this._sdk || !this._SHELL_EVENTS) { return; }
    try {
      this._sdk.emit(this._SHELL_EVENTS.Version1.SET_TITLE, { title: sTitle });
    } catch (e) { /* noop */ }
  };

  return FsmShell;
});
