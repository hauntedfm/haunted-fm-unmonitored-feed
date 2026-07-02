const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

loadEnv();

const PORT = Number(process.env.PORT || 3005);
const RECEIVER_TOKEN = process.env.RECEIVER_TOKEN || "change-me-feed";
const MAX_CALL_SECONDS = Number(process.env.MAX_CALL_SECONDS || 15);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || "*";
const PUBLIC_DIR = path.join(__dirname, "public");
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 12 * 1024 * 1024);

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

const clients = new Map();
const room = {
  receiverId: null,
  activeCallerId: null,
  startedAt: null,
  disconnectTimer: null,
  statusTimer: null,
  muted: false
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webm": "audio/webm",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, health());
    if (req.method === "GET" && url.pathname === "/events") return openEvents(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/recordings") return listRecordings(req, res, url);
    if (req.method === "GET" && url.pathname.startsWith("/recordings/")) return serveRecording(url.pathname, res, url);
    if (req.method === "POST" && url.pathname === "/api/transmit") return requestTransmission(req, res);
    if (req.method === "POST" && url.pathname === "/api/recording") return receiveRecording(req, res, url);
    if (req.method === "POST" && url.pathname === "/api/hangup") return callerHangup(req, res);
    if (req.method === "POST" && url.pathname === "/api/receiver/mute") return receiverMute(req, res);
    if (req.method === "POST" && url.pathname === "/api/receiver/disconnect") return receiverDisconnect(req, res);
    if (req.method === "POST" && url.pathname === "/api/signal") return relaySignal(req, res);
    if (req.method === "GET") return serveStatic(url.pathname, res);
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: "Signal failure" });
  }
});

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = PUBLIC_ORIGIN === "*"
    ? "*"
    : PUBLIC_ORIGIN.split(",").map((item) => item.trim()).includes(origin)
      ? origin
      : "";

  if (allowed) res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function health() {
  return {
    ok: true,
    receiverOnline: Boolean(room.receiverId),
    activeCaller: Boolean(room.activeCallerId),
    muted: room.muted
  };
}

function roomStatus() {
  const remainingMs = room.startedAt
    ? Math.max(0, MAX_CALL_SECONDS * 1000 - (Date.now() - room.startedAt))
    : 0;

  return {
    receiverOnline: Boolean(room.receiverId),
    occupied: Boolean(room.activeCallerId),
    activeCallerId: room.activeCallerId,
    muted: room.muted,
    maxCallSeconds: MAX_CALL_SECONDS,
    remainingSeconds: Math.ceil(remainingMs / 1000)
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readBuffer(req, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Upload too large");
      error.code = "UPLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function serveStatic(requestPath, res) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  const publicRoot = `${PUBLIC_DIR}${path.sep}`;

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(publicRoot)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      if (shouldServeAppShell(requestPath)) {
        fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, fallbackContents) => {
          if (fallbackError) {
            sendJson(res, 404, { ok: false, error: "Not found" });
            return;
          }

          res.writeHead(200, { "Content-Type": mimeTypes[".html"] });
          res.end(fallbackContents);
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: "Not found" });
      return;
    }

    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(contents);
  });
}

function shouldServeAppShell(requestPath) {
  if (requestPath.startsWith("/api/") || requestPath.startsWith("/recordings/") || requestPath === "/events" || requestPath === "/health") return false;
  return !path.extname(requestPath);
}

function requireReceiverToken(res, token) {
  if (token !== RECEIVER_TOKEN) {
    sendJson(res, 401, { ok: false, error: "Unauthorized receiver token" });
    return false;
  }
  return true;
}

function recordingUrl(fileName) {
  return `/recordings/${encodeURIComponent(fileName)}`;
}

function listRecordings(req, res, url) {
  if (!requireReceiverToken(res, url.searchParams.get("token"))) return;

  fs.readdir(RECORDINGS_DIR, { withFileTypes: true }, (error, entries) => {
    if (error) return sendJson(res, 200, { ok: true, recordings: [] });

    const recordings = entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filePath = path.join(RECORDINGS_DIR, entry.name);
        const stat = fs.statSync(filePath);
        return {
          name: entry.name,
          size: stat.size,
          createdAt: stat.birthtime.toISOString(),
          url: recordingUrl(entry.name)
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    sendJson(res, 200, { ok: true, recordings });
  });
}

function serveRecording(requestPath, res, url) {
  if (!requireReceiverToken(res, url.searchParams.get("token"))) return;

  const fileName = decodeURIComponent(requestPath.replace("/recordings/", ""));
  const safeName = path.basename(fileName);
  const filePath = path.join(RECORDINGS_DIR, safeName);

  fs.readFile(filePath, (error, contents) => {
    if (error) return sendJson(res, 404, { ok: false, error: "Recording not found" });
    const disposition = url.searchParams.get("download") === "1" ? "attachment" : "inline";
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Content-Disposition": `${disposition}; filename="${safeName}"`,
      "Content-Length": contents.length
    });
    res.end(contents);
  });
}

function openEvents(req, res, url) {
  const clientId = url.searchParams.get("clientId");
  const role = url.searchParams.get("role");
  const token = url.searchParams.get("token");

  if (!clientId || !["caller", "receiver"].includes(role)) {
    sendJson(res, 400, { ok: false, error: "Missing client identity" });
    return;
  }

  if (role === "receiver" && token !== RECEIVER_TOKEN) {
    sendJson(res, 401, { ok: false, error: "Unauthorized receiver token" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");

  clients.set(clientId, { id: clientId, role, res });

  if (role === "receiver") {
    room.receiverId = clientId;
    sendEvent(clientId, "receiver:ready", roomStatus());
  }

  sendEvent(clientId, "room:status", roomStatus());
  broadcastStatus();

  req.on("close", () => {
    clients.delete(clientId);
    if (clientId === room.receiverId) {
      room.receiverId = null;
      if (room.activeCallerId) endTransmission("RECEIVER OFFLINE");
      broadcastStatus();
    } else if (clientId === room.activeCallerId) {
      endTransmission("SIGNAL LOST");
    }
  });
}

function sendEvent(clientId, event, payload) {
  const client = clients.get(clientId);
  if (!client) return;
  client.res.write(`event: ${event}\n`);
  client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcastStatus() {
  const status = roomStatus();
  for (const client of clients.values()) sendEvent(client.id, "room:status", status);
}

function clearTimers() {
  if (room.disconnectTimer) clearTimeout(room.disconnectTimer);
  if (room.statusTimer) clearInterval(room.statusTimer);
  room.disconnectTimer = null;
  room.statusTimer = null;
}

function endTransmission(reason = "SIGNAL LOST") {
  clearTimers();
  if (room.activeCallerId) sendEvent(room.activeCallerId, "call:ended", { reason });
  if (room.receiverId) sendEvent(room.receiverId, "receiver:call-ended", { reason });
  room.activeCallerId = null;
  room.startedAt = null;
  room.muted = false;
  broadcastStatus();
}

async function requestTransmission(req, res) {
  const { clientId } = await readJson(req);
  if (!clientId) return sendJson(res, 400, { ok: false, reason: "SIGNAL FAILED" });

  if (room.activeCallerId && room.activeCallerId !== clientId) {
    sendEvent(clientId, "caller:occupied", {});
    return sendJson(res, 409, { ok: false, reason: "THE FREQUENCY IS OCCUPIED" });
  }

  room.activeCallerId = clientId;
  room.startedAt = Date.now();
  room.muted = false;
  clearTimers();
  room.disconnectTimer = setTimeout(() => endTransmission("SIGNAL LOST"), (MAX_CALL_SECONDS + 8) * 1000);
  room.statusTimer = setInterval(broadcastStatus, 1000);

  if (room.receiverId) {
    sendEvent(room.receiverId, "receiver:incoming-caller", {
      callerId: clientId,
      startedAt: room.startedAt
    });
  }
  sendEvent(clientId, "caller:accepted", roomStatus());
  broadcastStatus();
  sendJson(res, 200, { ok: true, status: roomStatus() });
}

async function receiveRecording(req, res, url) {
  const clientId = url.searchParams.get("clientId");
  if (!clientId || clientId !== room.activeCallerId) {
    return sendJson(res, 409, { ok: false, error: "No active transmission" });
  }

  try {
    const contentType = req.headers["content-type"] || "audio/webm";
    const extension = contentType.includes("mp4") ? ".m4a" : contentType.includes("ogg") ? ".ogg" : contentType.includes("wav") ? ".wav" : ".webm";
    const safeClient = clientId.replace(/[^a-z0-9-]/gi, "").slice(0, 12);
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeClient}${extension}`;
    const filePath = path.join(RECORDINGS_DIR, fileName);
    const buffer = await readBuffer(req, MAX_UPLOAD_BYTES);

    if (!buffer.length) return sendJson(res, 400, { ok: false, error: "Empty recording" });

    fs.writeFileSync(filePath, buffer);

    const recording = {
      name: fileName,
      size: buffer.length,
      createdAt: new Date().toISOString(),
      url: recordingUrl(fileName)
    };

    if (room.receiverId) sendEvent(room.receiverId, "receiver:recording-ready", recording);
    endTransmission("SIGNAL FILE DELIVERED");
    sendJson(res, 200, { ok: true, recording });
  } catch (error) {
    if (error.code === "UPLOAD_TOO_LARGE") return sendJson(res, 413, { ok: false, error: "Recording too large" });
    sendJson(res, 500, { ok: false, error: "Recording failed" });
  }
}

async function callerHangup(req, res) {
  const { clientId } = await readJson(req);
  if (clientId === room.activeCallerId) endTransmission("SIGNAL LOST");
  sendJson(res, 200, { ok: true });
}

async function receiverMute(req, res) {
  const { clientId, muted } = await readJson(req);
  if (clientId !== room.receiverId) return sendJson(res, 403, { ok: false, error: "Unauthorized receiver" });
  room.muted = Boolean(muted);
  if (room.activeCallerId) sendEvent(room.activeCallerId, "caller:muted", { muted: room.muted });
  sendEvent(room.receiverId, "receiver:muted", { muted: room.muted });
  broadcastStatus();
  sendJson(res, 200, { ok: true, muted: room.muted });
}

async function receiverDisconnect(req, res) {
  const { clientId } = await readJson(req);
  if (clientId !== room.receiverId) return sendJson(res, 403, { ok: false, error: "Unauthorized receiver" });
  endTransmission("SIGNAL TERMINATED");
  sendJson(res, 200, { ok: true });
}

async function relaySignal(req, res) {
  const { clientId, type, payload, targetId } = await readJson(req);

  if (clientId === room.activeCallerId && room.receiverId) {
    sendEvent(targetId || room.receiverId, `webrtc:${type}`, { from: clientId, callerId: clientId, ...payload });
    return sendJson(res, 200, { ok: true });
  }

  if (clientId === room.receiverId && room.activeCallerId) {
    sendEvent(targetId || room.activeCallerId, `webrtc:${type}`, { from: clientId, callerId: room.activeCallerId, ...payload });
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 409, { ok: false, error: "No active signal path" });
}

server.listen(PORT, () => {
  console.log(`Haunted FM unmonitored feed listening on http://localhost:${PORT}`);
});
