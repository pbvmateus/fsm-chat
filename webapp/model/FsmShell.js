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

    if (!this.isAvailable()) {
      onContext && onContext(null);
      return;
    }

    var FSMShell = window.FSMShell;
    var ShellSdk = FSMShell.ShellSdk;
    var SHELL_EVENTS = FSMShell.SHELL_EVENTS;
    this._SHELL_EVENTS = SHELL_EVENTS;

    var that = this;

    try {
      this._sdk = ShellSdk.init(window.parent, "*");
      this._inited = true;
    } catch (e) {
      onContext && onContext(null);
      return;
    }

    // --- 1. Listen for the context response BEFORE emitting the request. ---
    var contextHandled = false;
    try {
      this._sdk.on(SHELL_EVENTS.Version1.REQUIRE_CONTEXT, function (payload) {
        if (contextHandled) { return; }
        contextHandled = true;
        var ctx = null;
        try {
          ctx = (typeof payload === "string") ? JSON.parse(payload) : payload;
        } catch (parseErr) {
          ctx = null;
        }
        onContext && onContext(ctx);

        // After context is in, wire selection listeners.
        that._wireSelectionListeners();
      });
    } catch (e) {
      onContext && onContext(null);
    }

    // Surface SDK errors but never let them break the app.
    try {
      this._sdk.on(SHELL_EVENTS.ERROR, function () { /* swallow */ });
    } catch (e) { /* noop */ }

    // --- 2. Emit REQUIRE_CONTEXT to kick things off. ---
    try {
      this._sdk.emit(SHELL_EVENTS.Version1.REQUIRE_CONTEXT, {
        clientIdentifier: (opts && opts.clientIdentifier) || "fsm-chat-extension"
      });
    } catch (e) {
      if (!contextHandled) { onContext && onContext(null); }
    }

    // Safety: if the host never answers, don't hang forever.
    setTimeout(function () {
      if (!contextHandled) {
        contextHandled = true;
        onContext && onContext(null);
        that._wireSelectionListeners();
      }
    }, 4000);
  };

  /**
   * Try every plausible channel for "the selected activity".
   * All wrapped defensively; failures are expected and ignored.
   */
  FsmShell.prototype._wireSelectionListeners = function () {
    if (!this._sdk || !this._SHELL_EVENTS) { return; }
    var that = this;
    var SHELL_EVENTS = this._SHELL_EVENTS;

    function deliver(id) {
      if (!id || id === that._lastSelectedId) { return; }
      that._lastSelectedId = id;
      that._selectionCallback && that._selectionCallback(String(id));
    }

    // (a) ViewState keys. Documented as restricted for extensions (may throw),
    //     but cheap to attempt — some host/version combos still emit these.
    var viewStateKeys = ["ACTIVITY", "SERVICECALL", "SERVICE_CALL",
      "SELECTED_ACTIVITY", "TECHNICIAN", "selectedActivity"];
    if (typeof this._sdk.onViewState === "function") {
      viewStateKeys.forEach(function (key) {
        try {
          that._sdk.onViewState(key, function (val) {
            // val may be an id string or an object holding one.
            deliver(that._extractId(val));
          });
        } catch (e) { /* restricted — ignore */ }
      });
    }

    // (b) TO_APP-style inbound messages. Some custom hosts push selection here.
    try {
      this._sdk.on(SHELL_EVENTS.Version1.TO_APP, function (content) {
        if (!content) { return; }
        deliver(that._extractId(content));
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
