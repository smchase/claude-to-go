// Debug helper
const statusEl = document.getElementById('status');
function setStatus(msg, color = '#888') {
  statusEl.textContent = msg;
  statusEl.style.color = color;
  console.log('[claude-to-go]', msg);
}

// Terminal setup
let term, fitAddon, ws = null;

try {
  setStatus('Initializing terminal...');

  term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    disableStdin: true,  // Only allow input via the text box below
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
    },
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const terminalEl = document.getElementById('terminal');
  term.open(terminalEl);

  setStatus('Terminal ready, connecting...');
} catch (e) {
  setStatus('Terminal init error: ' + e.message, '#ef4444');
  console.error('Terminal init error:', e);
}

// Fit terminal to container
let lastCols = 0, lastRows = 0;
function fitTerminal() {
  try {
    fitAddon.fit();
    // Only send resize if dimensions actually changed
    if (ws && ws.readyState === WebSocket.OPEN && (term.cols !== lastCols || term.rows !== lastRows)) {
      lastCols = term.cols;
      lastRows = term.rows;
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  } catch (e) {
    console.error('Fit error:', e);
  }
}

fitTerminal();
// Debounce resize events
let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(fitTerminal, 100);
});

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  setStatus('Connecting to ' + wsUrl + '...');

  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    setStatus('WebSocket create error: ' + e.message, '#ef4444');
    return;
  }

  ws.onopen = () => {
    setStatus('Connected', '#22c55e');
    fitTerminal();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output') {
        term.write(msg.data);
      }
    } catch (e) {
      console.error('Message parse error:', e);
    }
  };

  ws.onclose = (e) => {
    setStatus('Disconnected (code: ' + e.code + ') - tap to reconnect', '#ef4444');
    statusEl.onclick = connect;
  };

  ws.onerror = (e) => {
    setStatus('Connection error', '#ef4444');
    console.error('WebSocket error:', e);
  };
}

connect();

// Send text to terminal
function sendToTerminal(text) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data: text }));
  }
}

// Input area
const textInput = document.getElementById('text-input');
const sendBtn = document.getElementById('send-btn');
const pttBtn = document.getElementById('ptt-btn');
const stopBtn = document.getElementById('stop-btn');

// Focus input on page load
textInput.focus();

// Auto-resize textarea
textInput.addEventListener('input', () => {
  textInput.style.height = 'auto';
  textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
});

// Send button
sendBtn.addEventListener('click', () => {
  const text = textInput.value;
  if (text) {
    // Two-step: send text first, then \r separately (works for Claude Code)
    sendToTerminal(text);
    setTimeout(() => sendToTerminal('\r'), 10);
    textInput.value = '';
    textInput.style.height = 'auto';
  } else {
    // Empty input - just send Enter
    sendToTerminal('\r');
  }
});

// Enter to send (Shift+Enter for newline)
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

// Stop button (Ctrl+C)
stopBtn.addEventListener('click', () => {
  sendToTerminal('\x03');
  textInput.focus();
});

// Push-to-talk
let mediaRecorder = null;
let audioChunks = [];
let currentStream = null;

async function startRecording() {
  // Don't start if already recording
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    console.log('Already recording');
    return;
  }

  try {
    currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(currentStream);
    audioChunks = [];

    console.log('Started recording, mimeType:', mediaRecorder.mimeType);

    mediaRecorder.ondataavailable = (e) => {
      console.log('Data available:', e.data.size, 'bytes');
      if (e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      console.log('Recording stopped, chunks:', audioChunks.length);

      // Stop all tracks
      if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
        currentStream = null;
      }

      pttBtn.classList.remove('recording');

      if (audioChunks.length === 0) {
        setStatus('No audio recorded', '#ef4444');
        return;
      }

      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const audioBlob = new Blob(audioChunks, { type: mimeType });
      console.log('Audio blob:', audioBlob.size, 'bytes, type:', mimeType);

      if (audioBlob.size < 1000) {
        setStatus('Recording too short', '#ef4444');
        return;
      }

      // Transcribe
      setStatus('Transcribing...', '#f59e0b');

      try {
        const response = await fetch('/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': mimeType },
          body: audioBlob,
        });

        const data = await response.json();

        if (data.transcript) {
          const current = textInput.value;
          textInput.value = current + (current ? ' ' : '') + data.transcript;
          textInput.dispatchEvent(new Event('input'));
          setStatus('Transcribed', '#22c55e');
        } else if (data.error) {
          setStatus('Transcription error: ' + data.error, '#ef4444');
        } else {
          setStatus('No speech detected', '#f59e0b');
        }
      } catch (err) {
        setStatus('Transcription failed', '#ef4444');
        console.error('Transcription error:', err);
      }
    };

    mediaRecorder.start();
    pttBtn.classList.add('recording');
    setStatus('Recording...', '#ef4444');
  } catch (err) {
    console.error('Failed to start recording:', err);
    setStatus('Microphone access denied', '#ef4444');
  }
}

function stopRecording() {
  console.log('stopRecording called, state:', mediaRecorder?.state);
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  } else {
    pttBtn.classList.remove('recording');
  }
}

// PTT button - use pointerdown/up for unified mouse+touch handling
pttBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  pttBtn.setPointerCapture(e.pointerId);
  startRecording();
});

pttBtn.addEventListener('pointerup', (e) => {
  e.preventDefault();
  stopRecording();
});

pttBtn.addEventListener('pointercancel', (e) => {
  stopRecording();
});

// Focus the input box when tapping the terminal area
// Use pointerup and check if it's a simple tap (not a selection drag)
let pointerStart = null;
document.getElementById('terminal').addEventListener('pointerdown', (e) => {
  pointerStart = { x: e.clientX, y: e.clientY, time: Date.now() };
}, true);

document.getElementById('terminal').addEventListener('pointerup', (e) => {
  if (!pointerStart) return;
  const dx = Math.abs(e.clientX - pointerStart.x);
  const dy = Math.abs(e.clientY - pointerStart.y);
  const dt = Date.now() - pointerStart.time;
  // If it was a quick tap without much movement, focus the input
  if (dx < 10 && dy < 10 && dt < 300) {
    textInput.focus();
  }
  pointerStart = null;
}, true);


