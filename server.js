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
    const code = err.cause?.code || err.code || 'unknown';
    console.error(`[${timestamp}] Transcription failed: ${err.message} (code: ${code})`);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

// Tmux session management
const { execSync } = require('child_process');
const crypto = require('crypto');

// Dedicated socket to avoid conflicts with user's default tmux
const TMUX_SOCKET = '/tmp/tmux-claude-to-go';

function generateSessionId() {
  return 'claude-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
}

function sessionExists(sessionId) {
  try {
    execSync(`tmux -S ${TMUX_SOCKET} has-session -t ${sessionId} 2>/dev/null`);
    return true;
  } catch (e) {
    return false;
  }
}

function createSession(sessionId, cols, rows) {
  try {
    execSync(`tmux -S ${TMUX_SOCKET} new-session -d -s ${sessionId} -x ${cols} -y ${rows}`, {
      cwd: process.env.HOME,
      env: process.env,
    });
    execSync(`tmux -S ${TMUX_SOCKET} set-option -t ${sessionId} status off`);
    console.log(`Created tmux session: ${sessionId}`);
    return true;
  } catch (e) {
    console.error(`Failed to create tmux session: ${e.message}`);
    return false;
  }
}

// Clean up sessions older than 24 hours
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function cleanupOldSessions() {
  try {
    const output = execSync(`tmux -S ${TMUX_SOCKET} list-sessions -F "#{session_name}" 2>/dev/null`, { encoding: 'utf8' });
    const sessions = output.trim().split('\n').filter(Boolean);
    const now = Date.now();

    for (const session of sessions) {
      // Extract timestamp from session name: claude-{timestamp}-{random}
      const match = session.match(/^claude-(\d+)-/);
      if (match) {
        const created = parseInt(match[1], 10);
        if (now - created > SESSION_MAX_AGE_MS) {
          execSync(`tmux -S ${TMUX_SOCKET} kill-session -t ${session} 2>/dev/null`);
          console.log(`Cleaned up old session: ${session}`);
        }
      }
    }
  } catch (e) {
    // No sessions or tmux not running
  }
}

// Run cleanup on startup and every hour
cleanupOldSessions();
setInterval(cleanupOldSessions, 60 * 60 * 1000);

// WebSocket handler for terminal
wss.on('connection', (ws) => {
  console.log('New terminal connection');

  let ptyProcess = null;
  let currentSessionId = null;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'connect') {
        const cols = msg.cols || 80;
        const rows = msg.rows || 24;

        if (msg.sessionId && sessionExists(msg.sessionId)) {
          console.log(`Reconnecting to tmux session: ${msg.sessionId}`);
          currentSessionId = msg.sessionId;
        } else {
          currentSessionId = generateSessionId();
          if (!createSession(currentSessionId, cols, rows)) {
            ws.send(JSON.stringify({ type: 'output', data: '\r\nFailed to create session\r\n' }));
            ws.close();
            return;
          }
        }

        ws.send(JSON.stringify({ type: 'session', sessionId: currentSessionId }));

        ptyProcess = pty.spawn('tmux', ['-S', TMUX_SOCKET, 'attach', '-t', currentSessionId], {
          name: 'xterm-256color',
          cols: cols,
          rows: rows,
          cwd: process.env.HOME,
          env: process.env,
        });

        ptyProcess.onData((data) => {
          try {
            ws.send(JSON.stringify({ type: 'output', data }));
          } catch (e) {
            // Connection closed
          }
        });

        ptyProcess.onExit(({ exitCode }) => {
          console.log(`PTY exited with code ${exitCode}`);
        });

      } else if (msg.type === 'input' && ptyProcess) {
        ptyProcess.write(msg.data);
      } else if (msg.type === 'resize' && ptyProcess) {
        ptyProcess.resize(msg.cols, msg.rows);
      }
    } catch (e) {
      // Invalid message, ignore
    }
  });

  ws.on('close', () => {
    console.log('Terminal connection closed');
    if (ptyProcess) ptyProcess.kill();
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
