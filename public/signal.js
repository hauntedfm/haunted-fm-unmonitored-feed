(function () {
  const clientId = crypto.randomUUID();
  const backendBase = (window.HAUNTED_FM_FEED_BACKEND || "").replace(/\/$/, "");
  const statusText = document.getElementById("statusText");
  const durationReadout = document.getElementById("durationReadout");
  const timerText = document.getElementById("timer");
  const receiverLabel = document.getElementById("receiverLabel");
  const roomLabel = document.getElementById("roomLabel");
  const speakButton = document.getElementById("speakButton");
  const hangupButton = document.getElementById("hangupButton");
  const meterBars = Array.from(document.querySelectorAll(".meter i"));

  const rtcConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }
    ]
  };

  let events = null;
  let peer = null;
  let localStream = null;
  let countdown = null;
  let durationTicker = null;
  let startedAt = null;
  let audioContext = null;
  let analyser = null;
  let maxSeconds = 15;

  function connectEvents() {
    events = new EventSource(`${backendBase}/events?role=caller&clientId=${encodeURIComponent(clientId)}`);

    events.addEventListener("room:status", (event) => {
      const status = JSON.parse(event.data);
      maxSeconds = status.maxCallSeconds || maxSeconds;
      receiverLabel.textContent = status.receiverOnline ? "ONLINE" : "OFFLINE";
      roomLabel.textContent = status.occupied ? "OCCUPIED" : "OPEN";
      if (!localStream) timerText.textContent = formatTime(maxSeconds);
    });

    events.addEventListener("webrtc:answer", async (event) => {
      if (!peer) return;
      const { sdp } = JSON.parse(event.data);
      await peer.setRemoteDescription(new RTCSessionDescription(sdp));
    });

    events.addEventListener("webrtc:ice-candidate", async (event) => {
      if (!peer) return;
      const { candidate } = JSON.parse(event.data);
      if (candidate) await peer.addIceCandidate(new RTCIceCandidate(candidate));
    });

    events.addEventListener("caller:occupied", () => resetUi("THE FREQUENCY IS OCCUPIED"));
    events.addEventListener("caller:no-receiver", () => resetUi("RECEIVER OFFLINE"));
    events.addEventListener("caller:muted", (event) => {
      const { muted } = JSON.parse(event.data);
      setStatus(muted ? "RECEIVER MUTED THE FEED" : "TRANSMITTING INTO FEED");
    });
    events.addEventListener("call:ended", (event) => {
      const { reason } = JSON.parse(event.data);
      cleanupMedia();
      resetUi(reason || "SIGNAL LOST");
    });
  }

  function setStatus(text) {
    statusText.textContent = text;
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

  function startCountdown() {
    let remaining = maxSeconds;
    timerText.textContent = formatTime(remaining);
    clearInterval(countdown);
    countdown = setInterval(() => {
      remaining -= 1;
      timerText.textContent = formatTime(remaining);
      if (remaining <= 0) clearInterval(countdown);
    }, 1000);
  }

  function startDuration() {
    startedAt = Date.now();
    durationReadout.textContent = "0.00";
    clearInterval(durationTicker);
    durationTicker = setInterval(() => {
      durationReadout.textContent = ((Date.now() - startedAt) / 1000).toFixed(2);
    }, 50);
  }

  function stopDuration() {
    clearInterval(durationTicker);
    durationTicker = null;
    startedAt = null;
  }

  function startMeter(stream) {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 64;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const values = new Uint8Array(analyser.frequencyBinCount);

    function draw() {
      if (!analyser) return;
      analyser.getByteFrequencyData(values);
      meterBars.forEach((bar, index) => {
        const value = values[index * 2] || 12;
        bar.style.transform = `scaleY(${Math.max(0.18, value / 160)})`;
      });
      requestAnimationFrame(draw);
    }

    draw();
  }

  function stopMeter() {
    meterBars.forEach((bar) => {
      bar.style.transform = "scaleY(0.18)";
    });
  }

  function resetUi(message) {
    setStatus(message || "SIGNAL LOST");
    speakButton.hidden = false;
    speakButton.disabled = false;
    hangupButton.hidden = true;
    timerText.textContent = formatTime(maxSeconds);
    clearInterval(countdown);
    stopDuration();
    stopMeter();
  }

  function cleanupMedia() {
    if (peer) {
      peer.onicecandidate = null;
      peer.close();
      peer = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
      analyser = null;
    }
  }

  async function beginTransmission() {
    speakButton.disabled = true;
    setStatus("SIGNAL ACCESS REQUESTED");

    const access = await postJson("/api/transmit", { clientId });
    if (!access.ok) {
      resetUi(access.reason || "TRANSMISSION FAILED");
      return;
    }

    try {
      maxSeconds = access.status.maxCallSeconds || maxSeconds;
      setStatus("MICROPHONE DETECTED");
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      peer = new RTCPeerConnection(rtcConfig);
      localStream.getAudioTracks().forEach((track) => peer.addTrack(track, localStream));
      peer.onicecandidate = (event) => {
        if (event.candidate) {
          postJson("/api/signal", {
            clientId,
            type: "ice-candidate",
            payload: { candidate: event.candidate }
          });
        }
      };

      const offer = await peer.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
      await peer.setLocalDescription(offer);
      await postJson("/api/signal", {
        clientId,
        type: "offer",
        payload: { sdp: peer.localDescription }
      });

      setStatus("TRANSMITTING INTO FEED");
      speakButton.hidden = true;
      hangupButton.hidden = false;
      startCountdown();
      startDuration();
      startMeter(localStream);
    } catch (error) {
      await postJson("/api/hangup", { clientId });
      cleanupMedia();
      resetUi(error.name === "NotAllowedError" ? "MICROPHONE ACCESS DENIED" : "SIGNAL FAILED");
    }
  }

  speakButton.addEventListener("click", beginTransmission);
  hangupButton.addEventListener("click", async () => {
    await postJson("/api/hangup", { clientId });
    cleanupMedia();
    resetUi("SIGNAL LOST");
  });

  connectEvents();
})();
