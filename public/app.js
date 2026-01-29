// Terminal setup
const term = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
  },
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);

const terminalEl = document.getElementById('terminal');
term.open(terminalEl);

// Fit terminal to container
function fitTerminal() {
  fitAddon.fit();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}

fitTerminal();
window.addEventListener('resize', fitTerminal);

// WebSocket connection
let ws = null;
const statusEl = document.getElementById('status');

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onopen = () => {
    statusEl.textContent = 'Connected';
    statusEl.style.color = '#22c55e';
    fitTerminal();
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'output') {
      term.write(msg.data);
    }
  };

  ws.onclose = () => {
    statusEl.textContent = 'Disconnected - tap to reconnect';
    statusEl.style.color = '#ef4444';
    statusEl.onclick = connect;
  };

  ws.onerror = () => {
    statusEl.textContent = 'Connection error';
    statusEl.style.color = '#ef4444';
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

// Auto-resize textarea
textInput.addEventListener('input', () => {
  textInput.style.height = 'auto';
  textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
});

// Send button
sendBtn.addEventListener('click', () => {
  const text = textInput.value;
  if (text) {
    sendToTerminal(text + '\n');
    textInput.value = '';
    textInput.style.height = 'auto';
  }
});

// Enter to send (Shift+Enter for newline)
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

// Push-to-talk
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      // Stop all tracks
      stream.getTracks().forEach(track => track.stop());

      if (audioChunks.length === 0) return;

      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });

      // Transcribe
      statusEl.textContent = 'Transcribing...';
      statusEl.style.color = '#f59e0b';

      try {
        const response = await fetch('/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/webm' },
          body: audioBlob,
        });

        const data = await response.json();

        if (data.transcript) {
          // Append to text input
          const current = textInput.value;
          textInput.value = current + (current ? ' ' : '') + data.transcript;
          textInput.dispatchEvent(new Event('input')); // Trigger resize
          statusEl.textContent = 'Transcribed';
          statusEl.style.color = '#22c55e';
        } else if (data.error) {
          statusEl.textContent = 'Transcription error: ' + data.error;
          statusEl.style.color = '#ef4444';
        }
      } catch (err) {
        statusEl.textContent = 'Transcription failed';
        statusEl.style.color = '#ef4444';
        console.error('Transcription error:', err);
      }
    };

    mediaRecorder.start();
    isRecording = true;
    pttBtn.classList.add('recording');
    statusEl.textContent = 'Recording...';
    statusEl.style.color = '#ef4444';
  } catch (err) {
    console.error('Failed to start recording:', err);
    statusEl.textContent = 'Microphone access denied';
    statusEl.style.color = '#ef4444';
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
    pttBtn.classList.remove('recording');
  }
}

// PTT button handlers (mouse and touch)
pttBtn.addEventListener('mousedown', (e) => {
  e.preventDefault();
  startRecording();
});

pttBtn.addEventListener('mouseup', () => {
  stopRecording();
});

pttBtn.addEventListener('mouseleave', () => {
  if (isRecording) stopRecording();
});

// Touch events for mobile
pttBtn.addEventListener('touchstart', (e) => {
  e.preventDefault();
  startRecording();
});

pttBtn.addEventListener('touchend', (e) => {
  e.preventDefault();
  stopRecording();
});

pttBtn.addEventListener('touchcancel', () => {
  if (isRecording) stopRecording();
});

// Allow clicking terminal to focus it (for scrolling, selection)
terminalEl.addEventListener('click', () => {
  term.focus();
});

// Handle terminal input directly (for arrow keys, etc when terminal is focused)
term.onData((data) => {
  sendToTerminal(data);
});
