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
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Transcription endpoint - proxies to Groq Whisper API
app.post('/transcribe', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const timestamp = new Date().toISOString();

  if (!GROQ_API_KEY) {
    console.error(`[${timestamp}] Transcription failed: GROQ_API_KEY not configured`);
    return res.status(500).json({ error: 'API key not configured' });
  }

  if (!req.body || req.body.length === 0) {
    console.error(`[${timestamp}] Transcription failed: Empty request body`);
    return res.status(400).json({ error: 'No audio data received' });
  }

  const contentType = req.headers['content-type'] || 'audio/webm';
  console.log(`[${timestamp}] Transcribe request: ${req.body.length} bytes, type: ${contentType}`);

  // Build multipart form data for Groq API
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const ext = contentType.includes('webm') ? 'webm' : contentType.includes('mp4') ? 'mp4' : 'wav';

  const formParts = [
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
    req.body,
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `whisper-large-v3-turbo\r\n` +
    `--${boundary}--\r\n`
  ];

  const body = Buffer.concat(formParts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

  try {
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: body,
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[${timestamp}] Groq API error (${response.status}): ${error}`);
      return res.status(response.status).json({ error: `Groq error: ${response.status}` });
    }

    const data = await response.json();
    const transcript = (data.text || '').trim();
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

// Dedicated socket to avoid conflicts with user's default tmux
const TMUX_SOCKET = '/tmp/tmux-claude-to-go';
const SESSION_NAME = 'claude-to-go';

function sessionExists() {
  try {
    execSync(`tmux -S ${TMUX_SOCKET} has-session -t ${SESSION_NAME} 2>/dev/null`);
    return true;
  } catch (e) {
    return false;
  }
}

function createSession(cols, rows) {
  try {
    execSync(`tmux -S ${TMUX_SOCKET} new-session -d -s ${SESSION_NAME} -x ${cols} -y ${rows}`, {
      cwd: process.env.HOME,
      env: process.env,
    });
    execSync(`tmux -S ${TMUX_SOCKET} set-option -t ${SESSION_NAME} status off`);
    console.log(`Created tmux session: ${SESSION_NAME}`);
    return true;
  } catch (e) {
    console.error(`Failed to create tmux session: ${e.message}`);
    return false;
  }
}

// WebSocket handler for terminal
wss.on('connection', (ws) => {
  console.log('New terminal connection');

  let ptyProcess = null;

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'connect') {
        const cols = msg.cols || 80;
        const rows = msg.rows || 24;

        // Create session if it doesn't exist
        if (!sessionExists()) {
          if (!createSession(cols, rows)) {
            ws.send(JSON.stringify({ type: 'output', data: '\r\nFailed to create session\r\n' }));
            ws.close();
            return;
          }
        }

        ptyProcess = pty.spawn('tmux', ['-S', TMUX_SOCKET, 'attach', '-t', SESSION_NAME], {
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
      } else if (msg.type === 'smart-stop' && ptyProcess) {
        // Check if shell is idle or running a command
        try {
          const result = execSync(`tmux -S ${TMUX_SOCKET} display-message -p -t ${SESSION_NAME} '#{pane_current_command}'`).toString().trim();
          if (result === 'bash' || result === 'zsh' || result === 'sh') {
            // At prompt - respawn pane with fresh shell (no visible command)
            execSync(`tmux -S ${TMUX_SOCKET} respawn-pane -k -t ${SESSION_NAME} -c ${process.env.HOME}`);
          } else {
            // Command running - send Ctrl+C
            ptyProcess.write('\x03');
          }
        } catch (e) {
          // Fallback to Ctrl+C if tmux query fails
          ptyProcess.write('\x03');
        }
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
