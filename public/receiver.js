(function () {
  const clientId = crypto.randomUUID();
  const backendBase = (window.HAUNTED_FM_FEED_BACKEND || "").replace(/\/$/, "");
  const receiverToken = window.HAUNTED_FM_RECEIVER_TOKEN || "";
  const receiverStatus = document.getElementById("receiverStatus");
  const receiverState = document.getElementById("receiverState");
  const callerState = document.getElementById("callerState");
  const roomState = document.getElementById("roomState");
  const countdownState = document.getElementById("countdownState");
  const outputState = document.getElementById("outputState");
  const remoteAudio = document.getElementById("remoteAudio");
  const muteButton = document.getElementById("muteButton");
  const disconnectButton = document.getElementById("disconnectButton");

  const rtcConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }
    ]
  };

  let events = null;
  let peer = null;
  let activeCallerId = null;
  let muted = false;

  function setReceiverStatus(text) {
    receiverStatus.textContent = text;
  }

  function formatTime(seconds) {
    return `00:${String(Math.max(0, seconds)).padStart(2, "0")}`;
  }

  async function postJson(url, body) {
    const response = await fetch(`${backendBase}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return response.json();
  }

  function updateStatus(status) {
    receiverState.textContent = status.receiverOnline ? "ONLINE" : "OFFLINE";
    roomState.textContent = status.occupied ? "OCCUPIED" : "OPEN";
    callerState.textContent = status.activeCallerId ? status.activeCallerId.slice(0, 8).toUpperCase() : "NO ACTIVE CALLER";
    countdownState.textContent = formatTime(status.remainingSeconds || 0);
    muted = Boolean(status.muted);
    muteButton.textContent = muted ? "RESTORE FEED" : "EMERGENCY MUTE";
    muteButton.disabled = !status.occupied;
    disconnectButton.disabled = !status.occupied;
  }

  function cleanupPeer() {
    if (peer) {
      peer.ontrack = null;
      peer.onicecandidate = null;
      peer.close();
      peer = null;
    }
    remoteAudio.srcObject = null;
    activeCallerId = null;
  }

  async function answerOffer(callerId, sdp) {
    cleanupPeer();
    activeCallerId = callerId;
    peer = new RTCPeerConnection(rtcConfig);

    peer.ontrack = (event) => {
      const [stream] = event.streams;
      remoteAudio.srcObject = stream;
      remoteAudio.muted = muted;
      remoteAudio.play().then(() => {
        outputState.textContent = "LIVE AUDIO ROUTING TO BROWSER OUTPUT";
      }).catch(() => {
        outputState.textContent = "PRESS PLAY TO ARM AUDIO OUTPUT";
      });
    };

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        postJson("/api/signal", {
          clientId,
          targetId: callerId,
          type: "ice-candidate",
          payload: { candidate: event.candidate }
        });
      }
    };

    await peer.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await postJson("/api/signal", {
      clientId,
      targetId: callerId,
      type: "answer",
      payload: { sdp: peer.localDescription }
    });
    setReceiverStatus("LIVE SIGNAL ENTERING FEED");
  }

  function connectReceiver() {
    if (events) events.close();
    const params = new URLSearchParams({
      role: "receiver",
      clientId,
      token: receiverToken
    });

    events = new EventSource(`${backendBase}/events?${params.toString()}`);
    events.addEventListener("open", () => setReceiverStatus("RECEIVER ONLINE"));
    events.addEventListener("error", () => {
      if (events.readyState === EventSource.CLOSED) setReceiverStatus("RECEIVER TOKEN REJECTED");
    });
    events.addEventListener("room:status", (event) => updateStatus(JSON.parse(event.data)));
    events.addEventListener("receiver:ready", (event) => {
      setReceiverStatus("RECEIVER ONLINE");
      updateStatus(JSON.parse(event.data));
    });
    events.addEventListener("receiver:incoming-caller", (event) => {
      const { callerId } = JSON.parse(event.data);
      activeCallerId = callerId;
      setReceiverStatus("INCOMING UNMONITORED SIGNAL");
    });
    events.addEventListener("webrtc:offer", (event) => {
      const { callerId, sdp } = JSON.parse(event.data);
      answerOffer(callerId, sdp).catch(() => setReceiverStatus("SIGNAL NEGOTIATION FAILED"));
    });
    events.addEventListener("webrtc:ice-candidate", async (event) => {
      if (!peer) return;
      const { candidate } = JSON.parse(event.data);
      if (candidate) await peer.addIceCandidate(new RTCIceCandidate(candidate));
    });
    events.addEventListener("receiver:muted", (event) => {
      const data = JSON.parse(event.data);
      muted = Boolean(data.muted);
      remoteAudio.muted = muted;
      muteButton.textContent = muted ? "RESTORE FEED" : "EMERGENCY MUTE";
    });
    events.addEventListener("receiver:call-ended", (event) => {
      const { reason } = JSON.parse(event.data);
      cleanupPeer();
      setReceiverStatus(reason || "SIGNAL LOST");
      outputState.textContent = "ROUTE THIS BROWSER AUDIO INTO THE FEED";
    });
  }

  muteButton.addEventListener("click", async () => {
    await postJson("/api/receiver/mute", { clientId, muted: !muted });
  });

  disconnectButton.addEventListener("click", async () => {
    await postJson("/api/receiver/disconnect", { clientId });
    cleanupPeer();
    setReceiverStatus("SIGNAL TERMINATED");
  });

  connectReceiver();
})();
