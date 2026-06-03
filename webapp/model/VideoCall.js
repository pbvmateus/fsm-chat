sap.ui.define([], function () {
  "use strict";

  /**
   * VideoCall — one-way WebRTC video: technician camera -> dispatcher view.
   *
   * ROLES
   *   caller (technician): captures the rear camera, creates the offer, sends
   *     its media to the viewer. Does not display incoming video.
   *   viewer (dispatcher): receives the offer, answers, displays the incoming
   *     video. Sends no media.
   *
   * SIGNALING rides the existing chat transport (relay) via sendSignal/onSignal,
   * scoped to the same room (activity). Message shapes (all type:"signal"):
   *   { signalType:"call-request" }           viewer or caller asks to start
   *   { signalType:"offer", sdp }              caller -> viewer
   *   { signalType:"answer", sdp }             viewer -> caller
   *   { signalType:"candidate", candidate }    both ways (ICE)
   *   { signalType:"hangup" }                  either side ends
   *
   * ICE: free public STUN only. TURN (for cross-cellular/firewall reliability)
   * can be added later by pushing entries into ICE_SERVERS — no other change.
   *
   * NOTE: real cross-device video requires the relay transport. Over the local
   * (BroadcastChannel) transport this only works between tabs on one machine.
   */

  // --- ICE configuration ---------------------------------------------------
  // Free Google STUN servers help peers discover their public addresses. They
  // do NOT relay media — if both peers are behind restrictive NAT/firewalls the
  // connection may fail. To make it reliable, add TURN servers here, e.g.:
  //   { urls: "turn:turn.example.com:3478", username: "u", credential: "p" }
  var ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];

  function VideoCall(oOpts) {
    // oOpts: { role, transport, onState, onRemoteStream, onLocalStream, onError }
    this._role = oOpts.role;              // "caller" or "viewer"
    this._transport = oOpts.transport;    // must have sendSignal()
    this._onState = oOpts.onState || function () {};
    this._onRemoteStream = oOpts.onRemoteStream || function () {};
    this._onLocalStream = oOpts.onLocalStream || function () {};
    this._onError = oOpts.onError || function () {};

    this._pc = null;
    this._localStream = null;
    this._active = false;
    this._pendingCandidates = [];
  }

  VideoCall.prototype.isActive = function () { return this._active; };

  VideoCall.prototype._state = function (s) {
    this._onState(s);
  };

  VideoCall.prototype._newPeer = function () {
    var that = this;
    var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = function (e) {
      if (e.candidate) {
        that._transport.sendSignal({
          signalType: "candidate",
          candidate: e.candidate
        });
      }
    };

    pc.oniceconnectionstatechange = function () {
      var st = pc.iceConnectionState;
      if (st === "connected" || st === "completed") {
        that._state("connected");
      } else if (st === "failed") {
        that._state("failed");
        that._onError(new Error("ICE connection failed — likely needs a TURN " +
          "server for this network."));
      } else if (st === "disconnected") {
        that._state("disconnected");
      }
    };

    // Viewer receives the remote media here.
    pc.ontrack = function (e) {
      if (e.streams && e.streams[0]) {
        that._onRemoteStream(e.streams[0]);
      }
    };

    this._pc = pc;
    return pc;
  };

  // --- Caller (technician) -------------------------------------------------
  VideoCall.prototype.startAsCaller = function () {
    var that = this;
    this._active = true;
    this._state("requesting-camera");

    var constraints = {
      video: { facingMode: { ideal: "environment" } },
      audio: false
    };

    return navigator.mediaDevices.getUserMedia(constraints)
      .then(function (stream) {
        that._localStream = stream;
        that._onLocalStream(stream);

        var pc = that._newPeer();
        stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });

        that._state("calling");
        return pc.createOffer();
      })
      .then(function (offer) {
        return that._pc.setLocalDescription(offer).then(function () {
          that._transport.sendSignal({
            signalType: "offer",
            sdp: that._pc.localDescription
          });
        });
      })
      .catch(function (err) {
        that._state("error");
        that._onError(err);
        that.hangup();
      });
  };

  // --- Viewer (dispatcher) handling an incoming offer ----------------------
  VideoCall.prototype._handleOffer = function (sdp) {
    var that = this;
    this._active = true;
    this._state("connecting");

    var pc = this._newPeer();

    pc.setRemoteDescription(new RTCSessionDescription(sdp))
      .then(function () {
        that._drainCandidates();
        return pc.createAnswer();
      })
      .then(function (answer) {
        return pc.setLocalDescription(answer).then(function () {
          that._transport.sendSignal({
            signalType: "answer",
            sdp: pc.localDescription
          });
        });
      })
      .catch(function (err) {
        that._state("error");
        that._onError(err);
        that.hangup();
      });
  };

  // --- Caller handling the viewer's answer ---------------------------------
  VideoCall.prototype._handleAnswer = function (sdp) {
    var that = this;
    if (!this._pc) { return; }
    this._pc.setRemoteDescription(new RTCSessionDescription(sdp))
      .then(function () { that._drainCandidates(); })
      .catch(function (err) { that._onError(err); });
  };

  VideoCall.prototype._handleCandidate = function (candidate) {
    if (!this._pc || !this._pc.remoteDescription) {
      // Remote description not set yet — queue it.
      this._pendingCandidates.push(candidate);
      return;
    }
    this._pc.addIceCandidate(new RTCIceCandidate(candidate))
      .catch(function () { /* candidate errors are common and non-fatal */ });
  };

  VideoCall.prototype._drainCandidates = function () {
    var that = this;
    var queued = this._pendingCandidates;
    this._pendingCandidates = [];
    queued.forEach(function (c) {
      that._pc.addIceCandidate(new RTCIceCandidate(c))
        .catch(function () { /* noop */ });
    });
  };

  // --- Signal router (called by the controller for each incoming signal) ---
  VideoCall.prototype.handleSignal = function (data) {
    switch (data.signalType) {
      case "offer":
        // Only the viewer should act on an offer.
        if (this._role === "viewer") { this._handleOffer(data.sdp); }
        break;
      case "answer":
        if (this._role === "caller") { this._handleAnswer(data.sdp); }
        break;
      case "candidate":
        this._handleCandidate(data.candidate);
        break;
      case "hangup":
        this._state("ended");
        this._teardown();
        break;
      default:
        break;
    }
  };

  // --- End the call --------------------------------------------------------
  VideoCall.prototype.hangup = function (bNotify) {
    if (bNotify !== false && this._transport) {
      try { this._transport.sendSignal({ signalType: "hangup" }); } catch (e) { /* noop */ }
    }
    this._state("ended");
    this._teardown();
  };

  VideoCall.prototype._teardown = function () {
    this._active = false;
    if (this._localStream) {
      this._localStream.getTracks().forEach(function (t) {
        try { t.stop(); } catch (e) { /* noop */ }
      });
      this._localStream = null;
    }
    if (this._pc) {
      try { this._pc.close(); } catch (e) { /* noop */ }
      this._pc = null;
    }
    this._pendingCandidates = [];
  };

  // Static helper so the UI can check support before showing a call button.
  VideoCall.isSupported = function () {
    return !!(window.RTCPeerConnection &&
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  };

  return VideoCall;
});
