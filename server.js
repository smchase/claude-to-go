const express = require('express');
const http = require('http');
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
const server = http.createServer(app);

const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Transcription endpoint - proxies to Deepgram
app.post('/transcribe', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
  const timestamp = new Date().toISOString();

  if (!DEEPGRAM_API_KEY) {
    console.error(`[${timestamp}] Transcription failed: DEEPGRAM_API_KEY not configured`);
    return res.status(500).json({ error: 'API key not configured' });
  }

  if (!req.body || req.body.length === 0) {
    console.error(`[${timestamp}] Transcription failed: Empty request body`);
    return res.status(400).json({ error: 'No audio data received' });
  }

  const contentType = req.headers['content-type'] || 'audio/webm';
  console.log(`[${timestamp}] Transcribe request: ${req.body.length} bytes, type: ${contentType}`);

  try {
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
      console.error(`[${timestamp}] Deepgram API error (${response.status}): ${error}`);
      return res.status(response.status).json({ error: `Deepgram error: ${response.status}` });
    }

    const data = await response.json();
    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
    console.log(`[${timestamp}] Transcription success: ${transcript.length} chars`);
    res.json({ transcript });
  } catch (err) {
    console.error(`[${timestamp}] Transcription failed: ${err.message}`);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

// WebSocket handler for terminal
wss.on('connection', (ws) => {
  console.log('New terminal connection');

  // Spawn shell using user's default shell
  const shell = process.env.SHELL || '/bin/bash';
  const ptyProcess = pty.spawn(shell, ['-l'], {
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
  console.log(`\nclaude-to-go running on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${localIP}:${PORT}\n`);
});
