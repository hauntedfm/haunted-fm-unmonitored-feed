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
  let localDownloadLink = null;

  let events = null;
  let localStream = null;
  let recorder = null;
  let recordedChunks = [];
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

    events.addEventListener("caller:occupied", () => resetUi("THE FREQUENCY IS OCCUPIED"));
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

  function showLocalDownload(blob) {
    if (localDownloadLink) localDownloadLink.remove();
    const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
    localDownloadLink = document.createElement("a");
    localDownloadLink.href = URL.createObjectURL(blob);
    localDownloadLink.download = `haunted-fm-transmission-${Date.now()}.${extension}`;
    localDownloadLink.textContent = "DOWNLOAD LOCAL FILE";
    localDownloadLink.className = "local-download";
    hangupButton.insertAdjacentElement("afterend", localDownloadLink);
  }

  function cleanupMedia() {
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    recorder = null;
    recordedChunks = [];
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

      setStatus("RECORDING TRANSMISSION FILE");
      speakButton.hidden = true;
      hangupButton.hidden = false;
      startCountdown();
      startDuration();
      startMeter(localStream);
      startRecording(localStream);
    } catch (error) {
      await postJson("/api/hangup", { clientId });
      cleanupMedia();
      resetUi(error.name === "NotAllowedError" ? "MICROPHONE ACCESS DENIED" : "SIGNAL FAILED");
    }
  }

  function chooseMimeType() {
    const options = [
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg"
    ];
    return options.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function startRecording(stream) {
    recordedChunks = [];
    recorder = new MediaRecorder(stream, chooseMimeType() ? { mimeType: chooseMimeType() } : undefined);

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size) recordedChunks.push(event.data);
    });

    recorder.addEventListener("stop", () => {
      uploadRecording().catch(() => resetUi("FILE DELIVERY FAILED"));
    });

    recorder.start();
    setTimeout(() => {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    }, maxSeconds * 1000);
  }

  async function uploadRecording() {
    stopDuration();
    stopMeter();
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
    }

    const type = recorder && recorder.mimeType ? recorder.mimeType : "audio/webm";
    const blob = new Blob(recordedChunks, { type });
    showLocalDownload(blob);
    setStatus("DELIVERING SIGNAL FILE");

    const response = await fetch(`${backendBase}/api/recording?clientId=${encodeURIComponent(clientId)}`, {
      method: "POST",
      headers: { "Content-Type": type },
      body: blob
    });
    const result = await response.json();

    if (!result.ok) {
      await postJson("/api/hangup", { clientId });
      resetUi("FILE DELIVERY FAILED - DOWNLOAD LOCAL FILE");
      return;
    }

    resetUi("SIGNAL FILE DELIVERED");
  }

  speakButton.addEventListener("click", beginTransmission);
  hangupButton.addEventListener("click", async () => {
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      hangupButton.disabled = true;
      setStatus("DELIVERING SIGNAL FILE");
      return;
    }
    await postJson("/api/hangup", { clientId });
    cleanupMedia();
    resetUi("SIGNAL LOST");
  });

  connectEvents();
})();
