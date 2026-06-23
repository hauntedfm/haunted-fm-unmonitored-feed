# Haunted FM Unmonitored Feed

Separate prototype for immediate browser call-ins.

## Local

```bash
node server.js
```

Open:

- Public caller: `http://localhost:3005/`
- Private receiver: `http://localhost:3005/receiver.html`
- Health: `http://localhost:3005/health`

Local receiver token defaults to:

```text
change-me-feed
```

## Render Deploy

Create a new Render Web Service from this folder/repo.

Settings:

```text
Runtime: Node
Build Command: leave blank
Start Command: node server.js
Health Check Path: /health
```

Environment variables:

```text
NODE_VERSION=20
RECEIVER_TOKEN=make-this-a-private-long-secret
MAX_CALL_SECONDS=15
PUBLIC_ORIGIN=https://your-netlify-site.netlify.app,https://www.hauntedfm.com,https://hauntedfm.com
```

If you are using the Render URL directly for the iframe before Netlify is ready, temporarily set:

```text
PUBLIC_ORIGIN=*
```

## Squarespace Embed

After deploying this app to Render:

```html
<iframe
  src="https://YOUR-RENDER-APP.onrender.com/"
  title="Haunted FM Speak Into The Feed"
  style="width:100%;max-width:760px;height:900px;border:0;background:#060605;display:block;margin:0 auto;"
  allow="microphone; autoplay"
></iframe>
```

Keep the receiver page private:

```text
https://YOUR-RENDER-APP.onrender.com/receiver.html
```

Route that browser's audio output into OBS, Loopback, Audio Hijack, VoiceMeeter, or your mixer.
