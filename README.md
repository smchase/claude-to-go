# clod2go

Mobile-friendly web terminal with push-to-talk voice input.

## Setup

```bash
# Install dependencies
npm install

# Create .env file with your Deepgram API key
cp .env.example .env
# Edit .env and add your DEEPGRAM_API_KEY

# Start the server
npm start
```

## Usage

1. Start the server: `npm start`
2. Open the URL shown in terminal on your phone (must be on same network)
3. Type in the text box and press Send, or hold the Mic button to speak

## Environment Variables

- `DEEPGRAM_API_KEY` - Your Deepgram API key for speech-to-text (uses Whisper large model)
- `PORT` - Server port (default: 3000)
