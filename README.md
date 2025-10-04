# DreamPulse Pipeline

Utility scripts for transforming user-submitted dreams into structured insights and generating a companion video via Freepik.

## Prerequisites

- Python 3.10+
- Freepik API key with access to the chosen text-to-video model
- Airia pipeline URL and API key

Install dependencies:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Copy `.env.example` to `.env` and populate it:

```
cp .env.example .env
```

Set the following values:

- `AIRIA_PIPELINE_URL` – PipelineExecution endpoint URL for dream analysis.
- `AIRIA_API_KEY` – API key for the Airia pipelines.
- `AIRIA_PROMPT_PIPELINE_URL` – (optional) Airia pipeline that turns structured analysis into a Freepik-ready prompt.
- `AIRIA_USER_ID` – (optional) Identifier forwarded to Airia prompt pipelines.
- `FREEPIK_API_KEY` – API key from Freepik.
- `CLICKHOUSE_URL` / `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` – (optional) HTTPS endpoint and credentials for ClickHouse.
- `CLICKHOUSE_DATABASE` / `CLICKHOUSE_TABLE` – (optional) target database and table names when persisting results (defaults to `DreamPulse-Central-Database-1`).

## Running the pipeline

Run the orchestration script with the dream text as an argument:

```bash
python -m dreampulse.main "Your dream text here"
```

Optional flags:

- `--duration {6,10}` – Video duration in seconds (default 6).
- `--model` – Freepik text-to-video model (default `minimax-hailuo-02-768p`).
- `--download PATH` – Where to save the generated video locally.
- `--prompt-url` / `--prompt-user-id` – Override prompt pipeline configuration without touching env vars.
- `--store-clickhouse` – Persist the output in ClickHouse using the configured credentials.
- `--clickhouse-table` – Override the ClickHouse table name for a single run (defaults to `DreamPulse-Central-Database-1`).

The script will:

1. Send the dream to the Airia pipeline for structured interpretation.
2. (Optional) Post the structured JSON to the Freepik prompt generator pipeline when configured.
3. Build a prompt from the Airia response or fallback to the original text.
4. Launch a Freepik video generation task, waiting for completion.
5. Print the analysis payload, prompt, and Freepik task metadata.

### Custom prompt logic

If the Airia payload exposes richer visual instructions, you can pass a custom `prompt_builder` callable to `generate_dream_video` in `dreampulse/services/pipeline.py`. The default builder tries common keys such as `video_prompt`, `visual_prompt`, and `summary` before falling back to the original dream text.

## Persisting results in ClickHouse

Run the CLI with `--store-clickhouse` once the ClickHouse variables are populated.
The helper will create the table if it does not exist (schema: UUID id, raw text, JSON blobs, prompt metadata, timestamps; default table `DreamPulse-Central-Database-1`) and insert a JSONEachRow payload over HTTPS using the supplied user credentials.

Example:

```bash
python -m dreampulse.main "...dream text..." \
  --store-clickhouse \
  --duration 10
```

The ClickHouse client posts to the HTTP interface (same format as `curl --data-binary 'INSERT …'`).
Make sure the service user has `INSERT` rights on the chosen table.

## Dream capture UI

A lightweight Node/Express server in `server/index.js` serves a prototype at `http://localhost:PORT` (defaults to 4000) with two capture modes:

- **Text Companion** – chat UI backed by `gpt-4o-mini` via `/api/chat`.
- **Voice Companion** – microphone streaming over a websocket proxy to the OpenAI realtime voice API.

### Setup

```bash
npm install
npm start
```

Environment variables (can live in `.env`):

- `OPENAI_API_KEY` – used for both chat completions and realtime voice.
- `AIRIA_API_KEY` – reused to call the prompt generator pipeline.
- `AIRIA_PROMPT_PIPELINE_URL` – optional; enables `/api/prompt` for Freepik prompt generation.
- `AIRIA_USER_ID` – optional; forwarded when invoking the prompt pipeline.
- `PORT` – optional port override for the Node server (default 4000).

The server also serves `web/index.html`, which sources `assets/js/app.js` and the `RealtimeVoiceClient` helper for WebSocket audio streaming.


## Freepik MCP

A ready-to-use MCP server config lives at `mcp/freepik-mcp.config.json`. Drop this into a Model Context Protocol-compatible client (Claude Desktop, Cursor, etc.) or merge the object into your existing MCP configuration. The snippet invokes Freepik's official MCP remote via `npx` and injects the API key through `FREEPIK_API_KEY`. Update the value or export `FREEPIK_API_KEY` in your shell if you prefer not to keep secrets in the file.

## Next steps

- Wrap the pipeline in an API or background worker to fan out simultaneous requests.
- Add speech-to-text ingestion to support voice submissions before calling the pipeline.
- Persist generated assets (JSON and video URL/path) for retrieval in a future UI.
