// Status helper
const statusEl = document.getElementById('status');
function setStatus(msg, color = '#888') {
  statusEl.textContent = msg;
  statusEl.style.color = color;
}

// Terminal setup
let term, fitAddon, ws = null;
const terminalEl = document.getElementById('terminal');

// Dynamic terminal growth - grow as content fills, iOS scrolls container
const FONT_SIZE = 14;
let LINE_HEIGHT = Math.ceil(FONT_SIZE * 1.2); // initial estimate, updated after render
const MAX_ROWS = 1000;
const container = document.getElementById('terminal-container');

term = new Terminal({
  cursorBlink: true,
  fontSize: FONT_SIZE,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  disableStdin: true,
  scrollback: 1000,
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
  },
});

fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(terminalEl);
fitAddon.fit();
// Prevent iOS keyboard but allow focus for cursor blinking
const helperTextarea = document.querySelector('.xterm-helper-textarea');
if (helperTextarea) {
  helperTextarea.setAttribute('readonly', 'true');
  helperTextarea.setAttribute('inputmode', 'none');
}

term.focus();

// Keep terminal focused when tapping anywhere
document.addEventListener('click', () => term.focus());

// Track current terminal row capacity
let currentRows = term.rows;

// Get actual line height from rendered terminal
setTimeout(() => {
  const screen = document.querySelector('.xterm-screen');
  if (screen && term.rows > 0) {
    LINE_HEIGHT = screen.offsetHeight / term.rows;
    updateTerminalHeight();
  }
}, 100);

function getVisibleRows() {
  return Math.floor(container.clientHeight / LINE_HEIGHT);
}

function getLastContentRow() {
  // Find the last row that has actual content (not blank)
  // Only scan the viewport (rendered rows), ignore any scrollback
  const buffer = term.buffer.active;
  const baseY = buffer.baseY;

  for (let i = term.rows - 1; i >= 0; i--) {
    const line = buffer.getLine(baseY + i);
    if (line && line.translateToString().trim() !== '') {
      return i + 1; // return row count within viewport (1-indexed)
    }
  }
  return 1; // at least 1 row
}

function isAtBottom() {
  const threshold = 20;
  return container.scrollTop + container.clientHeight >= container.scrollHeight - threshold;
}

function scrollToBottom() {
  container.scrollTop = container.scrollHeight - container.clientHeight;
}

function updateTerminalHeight() {
  // Element height = actual content height (last non-empty row)
  // +1 to ensure last row is fully visible when scrolled to bottom
  const contentRows = getLastContentRow() + 1;
  const visibleRows = getVisibleRows();
  const displayRows = Math.max(contentRows, visibleRows);
  terminalEl.style.height = (displayRows * LINE_HEIGHT) + 'px';
}

function growTerminalIfNeeded() {
  const cursorY = term.buffer.active.cursorY;

  // Grow terminal capacity if cursor is near the limit
  if (cursorY >= currentRows - 3 && currentRows < MAX_ROWS) {
    currentRows = Math.min(cursorY + getVisibleRows() + 10, MAX_ROWS);
    term.resize(term.cols, currentRows);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: currentRows }));
    }
  }
}

updateTerminalHeight();

// WebSocket connection
function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  setStatus('Connecting...');

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setStatus('Connected', '#22c55e');
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: currentRows }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'output') {
      // Check if at bottom BEFORE write
      const wasAtBottom = isAtBottom();

      // Use callback to update height after write is processed
      term.write(msg.data, () => {
        growTerminalIfNeeded();
        updateTerminalHeight();

        // If user was at bottom, keep them there
        if (wasAtBottom) {
          scrollToBottom();
        }
      });
    }
  };

  ws.onclose = (e) => {
    setStatus('Disconnected - tap to reconnect', '#ef4444');
    document.onclick = () => {
      document.onclick = null;
      term.write('\x1b[?25h');  // Show cursor (DECTCEM)
      connect();
    };
  };

  ws.onerror = () => setStatus('Connection error', '#ef4444');
}

connect();

// Send text to terminal
function sendToTerminal(text) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data: text }));
    // User is typing - scroll to bottom
    scrollToBottom();
  }
}

// Keyboard layouts
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

let shiftActive = false;
let currentLayout = 'default';

// Key repeat settings
const KEY_REPEAT_DELAY = 300;  // ms before repeat starts
const KEY_REPEAT_RATE = 25;    // ms between repeats
let repeatTimeout = null;
let repeatInterval = null;
let currentHeldKey = null;

const Keyboard = window.SimpleKeyboard.default;
const keyboard = new Keyboard({
  onChange: () => {},
  onKeyPress: handleKeyPress,
  onKeyReleased: () => {
    clearTimeout(repeatTimeout);
    clearInterval(repeatInterval);
    currentHeldKey = null;
  },
  layout: layouts,
  layoutName: 'default',
  display: display,
  theme: 'simple-keyboard hg-theme-default',
  physicalKeyboardHighlight: false,
  preventMouseDownDefault: true,
  preventMouseUpDefault: true,
  disableButtonHold: true,
  buttonTheme: [
    { class: 'mic-btn', buttons: '{mic}' },
    { class: 'ctrlc-btn', buttons: '{ctrlc}' }
  ]
});

function handleKeyPress(button) {
  // If same key is already held and repeating, ignore (simple-keyboard's own repeat)
  if (currentHeldKey === button) {
    return;
  }

  // Clear any existing repeat
  clearTimeout(repeatTimeout);
  clearInterval(repeatInterval);
  currentHeldKey = button;

  // Keys that should repeat when held
  const repeatableKeys = ['{bksp}', '{space}', '{enter}'];
  const isRepeatable = repeatableKeys.includes(button) || !button.startsWith('{');

  function doKeyAction() {
    switch (button) {
      case '{shift}':
        shiftActive = !shiftActive;
        keyboard.setOptions({ layoutName: shiftActive ? 'shift' : 'default' });
        updateShiftButton();
        return false; // don't repeat
      case '{numbers}':
        keyboard.setOptions({ layoutName: 'numbers' });
        currentLayout = 'numbers';
        shiftActive = false;
        return false;
      case '{symbols}':
        keyboard.setOptions({ layoutName: 'symbols' });
        currentLayout = 'symbols';
        return false;
      case '{abc}':
        keyboard.setOptions({ layoutName: 'default' });
        currentLayout = 'default';
        shiftActive = false;
        return false;
      case '{bksp}':
        sendToTerminal('\x7f');
        return true;
      case '{enter}':
        sendToTerminal('\r');
        return true;
      case '{space}':
        sendToTerminal(' ');
        return true;
      case '{ctrlc}':
        sendToTerminal('\x03');
        return false;
      case '{mic}':
        handleMicPress();
        return false;
      default:
        sendToTerminal(button);
        if (shiftActive && currentLayout === 'default') {
          shiftActive = false;
          keyboard.setOptions({ layoutName: 'default' });
          updateShiftButton();
        }
        return true;
    }
  }

  const shouldRepeat = doKeyAction();

  // Set up key repeat for repeatable keys
  if (shouldRepeat && isRepeatable) {
    repeatTimeout = setTimeout(() => {
      repeatInterval = setInterval(() => doKeyAction(), KEY_REPEAT_RATE);
    }, KEY_REPEAT_DELAY);
  }
}

function updateShiftButton() {
  const shiftBtn = document.querySelector('[data-skbtn="{shift}"]');
  if (shiftBtn) {
    shiftBtn.classList.toggle('shift-active', shiftActive);
  }
}

// Voice recording
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
      if (e.data.size > 0) audioChunks.push(e.data);
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

        if (!response.ok) {
          setStatus(`Server error: ${response.status}`, '#ef4444');
          return;
        }

        const data = await response.json();

        if (data.transcript) {
          sendToTerminal(data.transcript);
          setStatus('Transcribed', '#22c55e');
        } else if (data.error) {
          setStatus(data.error, '#ef4444');
        } else {
          setStatus('No speech detected', '#f59e0b');
        }
      } catch (err) {
        setStatus(`Network error: ${err.message}`, '#ef4444');
      }
    };

    mediaRecorder.start();
  } catch (err) {
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
    micBtn.classList.toggle('recording', isRecording);
  }
}
