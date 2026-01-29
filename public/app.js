// Status helper
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
    disableStdin: true,
    theme: {
      background: '#1e1e1e',
      foreground: '#d4d4d4',
    },
  });

  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const terminalEl = document.getElementById('terminal');
  term.open(terminalEl);

  // Prevent iOS keyboard on terminal tap
  const helperTextarea = document.querySelector('.xterm-helper-textarea');
  if (helperTextarea) {
    helperTextarea.setAttribute('readonly', 'true');
    helperTextarea.setAttribute('inputmode', 'none');
  }

  setStatus('Terminal ready, connecting...');
} catch (e) {
  setStatus('Terminal init error: ' + e.message, '#ef4444');
  console.error('Terminal init error:', e);
}

// Fit terminal
try {
  fitAddon.fit();
} catch (e) {
  console.error('Fit error:', e);
}

// WebSocket connection
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
    fitAddon.fit();
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
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

// Keep terminal focused
document.addEventListener('click', () => term.focus());

// Send text to terminal
function sendToTerminal(text) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data: text }));
    term.scrollToBottom();
  }
}

// Keyboard layouts (iOS-style)
const layouts = {
  default: [
    'q w e r t y u i o p',
    'a s d f g h j k l',
    '{shift} z x c v b n m {bksp}',
    '{numbers} {ctrlc} {space} {mic} {enter}'
  ],
  shift: [
    'Q W E R T Y U I O P',
    'A S D F G H J K L',
    '{shift} Z X C V B N M {bksp}',
    '{numbers} {ctrlc} {space} {mic} {enter}'
  ],
  numbers: [
    '1 2 3 4 5 6 7 8 9 0',
    '- / : ; ( ) $ & @ "',
    '{symbols} . , ? ! \' {bksp}',
    '{abc} {ctrlc} {space} {mic} {enter}'
  ],
  symbols: [
    '[ ] { } # % ^ * + =',
    '_ \\ | ~ < > € £ ¥ •',
    '{numbers} . , ? ! \' {bksp}',
    '{abc} {ctrlc} {space} {mic} {enter}'
  ]
};

const display = {
  '{shift}': '⇧',
  '{bksp}': '⌫',
  '{enter}': '⏎',
  '{space}': ' ',
  '{numbers}': '123',
  '{symbols}': '#+=',
  '{abc}': 'ABC',
  '{ctrlc}': ' ',
  '{mic}': ' '
};

// Keyboard state
let shiftActive = false;
let currentLayout = 'default';

// Initialize keyboard
const Keyboard = window.SimpleKeyboard.default;
const keyboard = new Keyboard({
  onChange: () => {},
  onKeyPress: handleKeyPress,
  layout: layouts,
  layoutName: 'default',
  display: display,
  theme: 'simple-keyboard hg-theme-default',
  physicalKeyboardHighlight: false,
  preventMouseDownDefault: true,
  preventMouseUpDefault: true,
  buttonTheme: [
    {
      class: 'mic-btn',
      buttons: '{mic}'
    },
    {
      class: 'ctrlc-btn',
      buttons: '{ctrlc}'
    }
  ]
});

function handleKeyPress(button) {
  console.log('Key pressed:', button);

  // Handle special keys
  switch (button) {
    case '{shift}':
      shiftActive = !shiftActive;
      keyboard.setOptions({
        layoutName: shiftActive ? 'shift' : 'default'
      });
      updateShiftButton();
      return;

    case '{numbers}':
      currentLayout = 'numbers';
      keyboard.setOptions({ layoutName: 'numbers' });
      shiftActive = false;
      updateShiftButton();
      return;

    case '{symbols}':
      currentLayout = 'symbols';
      keyboard.setOptions({ layoutName: 'symbols' });
      return;

    case '{abc}':
      currentLayout = 'default';
      keyboard.setOptions({ layoutName: 'default' });
      shiftActive = false;
      updateShiftButton();
      return;

    case '{bksp}':
      sendToTerminal('\x7f');
      return;

    case '{enter}':
      sendToTerminal('\r');
      return;

    case '{space}':
      sendToTerminal(' ');
      return;

    case '{ctrlc}':
      sendToTerminal('\x03');
      return;

    case '{mic}':
      handleMicPress();
      return;

    default:
      // Regular character - send to terminal
      sendToTerminal(button);

      // Auto-disable shift after typing a character
      if (shiftActive && currentLayout !== 'numbers' && currentLayout !== 'symbols') {
        shiftActive = false;
        keyboard.setOptions({ layoutName: 'default' });
        updateShiftButton();
      }
  }
}

function updateShiftButton() {
  const shiftBtn = document.querySelector('[data-skbtn="{shift}"]');
  if (shiftBtn) {
    if (shiftActive) {
      shiftBtn.classList.add('shift-active');
    } else {
      shiftBtn.classList.remove('shift-active');
    }
  }
}

// Voice recording (toggle)
let mediaRecorder = null;
let audioChunks = [];
let currentStream = null;
let isRecording = false;

async function handleMicPress() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

async function startRecording() {
  if (isRecording) return;

  try {
    currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(currentStream);
    audioChunks = [];
    isRecording = true;

    updateMicButton();
    setStatus('Recording...', '#ef4444');

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      isRecording = false;
      updateMicButton();

      if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
        currentStream = null;
      }

      if (audioChunks.length === 0) {
        setStatus('No audio recorded', '#ef4444');
        return;
      }

      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      const audioBlob = new Blob(audioChunks, { type: mimeType });

      if (audioBlob.size < 1000) {
        setStatus('Recording too short', '#ef4444');
        return;
      }

      setStatus('Transcribing...', '#f59e0b');

      try {
        const response = await fetch('/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': mimeType },
          body: audioBlob,
        });

        const data = await response.json();

        if (data.transcript) {
          // Send transcribed text directly to terminal
          sendToTerminal(data.transcript);
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
  } catch (err) {
    console.error('Failed to start recording:', err);
    setStatus('Microphone access denied', '#ef4444');
    isRecording = false;
    updateMicButton();
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  isRecording = false;
  updateMicButton();
}

function updateMicButton() {
  const micBtn = document.querySelector('[data-skbtn="{mic}"]');
  if (micBtn) {
    if (isRecording) {
      micBtn.classList.add('recording');
    } else {
      micBtn.classList.remove('recording');
    }
  }
}
