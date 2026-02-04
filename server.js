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

// Simple logger with consistent timestamp format
function log(level, category, msg, details = null) {
  const timestamp = new Date().toISOString();
  const detailStr = details ? ' ' + JSON.stringify(details) : '';
  console[level](`[${timestamp}] [${category}] ${msg}${detailStr}`);
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Transcription endpoint - proxies to Groq Whisper API
app.post('/transcribe', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const timestamp = new Date().toISOString();
  const requestId = Math.random().toString(36).slice(2, 10);
  const startTime = Date.now();

  const log = (level, msg, details = {}) => {
    const elapsed = Date.now() - startTime;
    const detailStr = Object.keys(details).length > 0 ? ' ' + JSON.stringify(details) : '';
    console[level](`[${timestamp}] [${requestId}] [${elapsed}ms] ${msg}${detailStr}`);
  };

  if (!GROQ_API_KEY) {
    log('error', 'Transcription failed: GROQ_API_KEY not configured');
    return res.status(500).json({ error: 'API key not configured' });
  }

  if (!req.body || req.body.length === 0) {
    log('error', 'Transcription failed: Empty request body');
    return res.status(400).json({ error: 'No audio data received' });
  }

  const contentType = req.headers['content-type'] || 'audio/webm';
  log('info', 'Transcribe request received', { bytes: req.body.length, contentType });

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
  log('info', 'Request prepared', { payloadBytes: body.length });

  try {
    log('info', 'Sending request to Groq API');
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Connection': 'close',  // Disable keep-alive to avoid stale connection pool issues
      },
      body: body,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const headers = Object.fromEntries(response.headers.entries());
      log('error', 'Groq API returned error', {
        status: response.status,
        statusText: response.statusText,
        headers,
        body: errorBody.slice(0, 1000),
      });
      return res.status(response.status).json({ error: `Groq error: ${response.status}` });
    }

    const data = await response.json();
    const transcript = (data.text || '').trim();
    log('info', 'Transcription success', { chars: transcript.length });
    res.json({ transcript });
  } catch (err) {
    // Extract all possible error details
    const errorDetails = {
      message: err.message,
      name: err.name,
      code: err.code,
      errno: err.errno,
      syscall: err.syscall,
      hostname: err.hostname,
      cause: err.cause ? {
        message: err.cause.message,
        code: err.cause.code,
        errno: err.cause.errno,
        syscall: err.cause.syscall,
        hostname: err.cause.hostname,
      } : undefined,
      stack: err.stack,
    };
    // Remove undefined values
    Object.keys(errorDetails).forEach(k => errorDetails[k] === undefined && delete errorDetails[k]);
    if (errorDetails.cause) {
      Object.keys(errorDetails.cause).forEach(k => errorDetails.cause[k] === undefined && delete errorDetails.cause[k]);
    }

    log('error', 'Transcription failed - network/fetch error', errorDetails);
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
    log('info', 'tmux', `Created session: ${SESSION_NAME}`, { cols, rows });
    return true;
  } catch (e) {
    log('error', 'tmux', `Failed to create session: ${e.message}`);
    return false;
  }
}

// WebSocket handler for terminal
wss.on('connection', (ws) => {
  const connId = Math.random().toString(36).slice(2, 8);
  log('info', 'ws', 'New terminal connection', { connId });

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
          log('info', 'pty', 'PTY exited', { connId, exitCode });
        });

      } else if (msg.type === 'input' && ptyProcess) {
        ptyProcess.write(msg.data);
      } else if (msg.type === 'resize' && ptyProcess) {
        ptyProcess.resize(msg.cols, msg.rows);
      } else if (msg.type === 'smart-stop' && ptyProcess) {
        // Check if shell is idle or running a command
        try {
          const currentCmd = execSync(`tmux -S ${TMUX_SOCKET} display-message -p -t ${SESSION_NAME} '#{pane_current_command}'`).toString().trim();
          if (currentCmd === 'bash' || currentCmd === 'zsh' || currentCmd === 'sh') {
            // At prompt - respawn pane with fresh shell (no visible command)
            log('info', 'smart-stop', 'Respawning shell (at prompt)', { connId, currentCmd });
            execSync(`tmux -S ${TMUX_SOCKET} respawn-pane -k -t ${SESSION_NAME} -c ${process.env.HOME}`);
          } else {
            // Command running - send Ctrl+C
            log('info', 'smart-stop', 'Sending Ctrl+C (command running)', { connId, currentCmd });
            ptyProcess.write('\x03');
          }
        } catch (e) {
          // Fallback to Ctrl+C if tmux query fails
          log('warn', 'smart-stop', 'Tmux query failed, sending Ctrl+C', { connId, error: e.message });
          ptyProcess.write('\x03');
        }
      }
    } catch (e) {
      // Invalid message, ignore
    }
  });

  ws.on('close', () => {
    log('info', 'ws', 'Terminal connection closed', { connId });
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
  log('info', 'server', 'Started', { port: PORT, local: `http://localhost:${PORT}`, network: `http://${localIP}:${PORT}` });
});
