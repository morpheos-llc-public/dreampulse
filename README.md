# DreamPulse Pipeline

Utility scripts for transforming user-submitted dreams into structured insights and generating a companion video via Freepik.

## Prerequisites

- Node.js 18+
- OpenAI API key for GPT and Realtime Voice API
- Freepik API key for video generation

Install dependencies:

```bash
npm install
```

## Setup

**IMPORTANT: Never commit your .env file to git!**

Copy `.env.example` to `.env` and populate it with your API keys:

```bash
cp .env.example .env
```

Set the following required values in `.env`:

- `OPENAI_API_KEY` – Your OpenAI API key (get one at https://platform.openai.com/api-keys)
- `FREEPIK_API_KEY` – Your Freepik API key (get one at https://www.freepik.com/api)

Optional values:

- `CLICKHOUSE_URL` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` – For persisting results to ClickHouse
- `CLICKHOUSE_DATABASE` / `CLICKHOUSE_TABLE` – Database and table names
- `PORT` – Server port (default: 4000)

## Running the Application

Start the Node.js server:

```bash
npm start
```

Then open http://localhost:4000 in your browser.

## How It Works

The application provides two modes for capturing dreams:

### Text Mode
- Chat interface powered by OpenAI GPT-4o-mini
- AI asks follow-up questions to help recall dream details
- Builds a comprehensive dream narrative

### Voice Mode
- Push-to-talk voice interface using OpenAI Realtime Voice API
- Hold the "Hold to Speak" button to record
- AI responds with voice and asks follow-up questions
- Transcripts are displayed in real-time

### Video Generation Pipeline

When you submit your dream, the system:

1. **Analyzes** the dream using OpenAI to generate a psychological interpretation
2. **Generates** a cinematic video prompt optimized for AI video generation
3. **Creates** a video using Freepik's text-to-video API (minimax-hailuo-02-768p model)
4. **Displays** the interpretation and generated video

## API Endpoints

- `GET /health` - Health check endpoint
- `POST /api/chat` - Text chat with GPT-4o-mini
- `POST /api/transcribe` - Audio transcription via Whisper
- `POST /api/submit-dream` - Submit dream for interpretation and video generation
- `WS /realtime` - WebSocket proxy to OpenAI Realtime Voice API

## Security Notes

**⚠️ CRITICAL: Your .env file contains sensitive API keys and should NEVER be committed to git!**

If you accidentally committed your .env file:
1. Immediately revoke and regenerate all exposed API keys
2. Remove .env from git history (it's already in .gitignore)
3. Force push the cleaned history

The .env.example file is safe to commit and shows the required format without actual keys.

## Architecture

- **Backend**: Node.js/Express server (`server/index.js`)
- **Frontend**: Static HTML/CSS/JS (`web/` directory)
- **Voice**: WebSocket proxy between client and OpenAI Realtime API
- **Video**: Freepik API integration with polling for completion
- **AI**: OpenAI GPT-4o-mini for dream interpretation and prompt generation
