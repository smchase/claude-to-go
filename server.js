const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const pty = require('node-pty');
const path = require('path');

// Load .env if present
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed, use process.env directly
}

const app = express();

// Use HTTPS if certs exist (required for microphone access on mobile)
const certPath = path.join(__dirname, 'certs');
const useHttps = fs.existsSync(path.join(certPath, 'key.pem')) && fs.existsSync(path.join(certPath, 'cert.pem'));

let server;
if (useHttps) {
  server = https.createServer({
    key: fs.readFileSync(path.join(certPath, 'key.pem')),
    cert: fs.readFileSync(path.join(certPath, 'cert.pem')),
  }, app);
} else {
  server = http.createServer(app);
}

const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Transcription endpoint - proxies to Deepgram
app.post('/transcribe', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  if (!DEEPGRAM_API_KEY) {
    return res.status(500).json({ error: 'DEEPGRAM_API_KEY not configured' });
  }

  const contentType = req.headers['content-type'] || 'audio/webm';
  console.log('Transcribe request:', req.body.length, 'bytes, content-type:', contentType);

  try {
    // Use detect_language and let Deepgram figure out the encoding
    const response = await fetch('https://api.deepgram.com/v1/listen?model=whisper-large&detect_language=true&smart_format=true', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': contentType,
      },
      body: req.body,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Deepgram error:', error);
      return res.status(response.status).json({ error: 'Transcription failed: ' + error });
    }

    const data = await response.json();
    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    res.json({ transcript });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: 'Transcription failed' });
  }
});

// WebSocket handler for terminal
wss.on('connection', (ws) => {
  console.log('New terminal connection');

  // Spawn shell using user's default shell
  const shell = process.env.SHELL || '/bin/bash';
  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: process.env,
  });

  // Terminal output -> WebSocket
  ptyProcess.onData((data) => {
    try {
      ws.send(JSON.stringify({ type: 'output', data }));
    } catch (e) {
      // Connection closed
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`Shell exited with code ${exitCode}`);
    ws.close();
  });

  // WebSocket -> Terminal input
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'input') {
        ptyProcess.write(msg.data);
      } else if (msg.type === 'resize') {
        ptyProcess.resize(msg.cols, msg.rows);
      }
    } catch (e) {
      // Invalid message, ignore
    }
  });

  ws.on('close', () => {
    console.log('Terminal connection closed');
    ptyProcess.kill();
  });
});

// Get local IP for display
const { networkInterfaces } = require('os');
function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  const protocol = useHttps ? 'https' : 'http';
  console.log(`\nclaude-to-go running!`);
  console.log(`  Local:   ${protocol}://localhost:${PORT}`);
  console.log(`  Network: ${protocol}://${localIP}:${PORT}`);
  if (useHttps) {
    console.log(`\n  Note: Accept the self-signed certificate warning in your browser.`);
  }
  console.log(`\nOpen the Network URL on your phone to connect.\n`);
});
