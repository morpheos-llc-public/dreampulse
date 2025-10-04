const path = require('path');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');
const fs = require('fs');
require('dotenv').config();

const upload = multer({ dest: '/tmp/' });

const fetch = global.fetch ?? ((...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args)));
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AIRIA_API_KEY = process.env.AIRIA_API_KEY;
const AIRIA_PIPELINE_URL = process.env.AIRIA_PIPELINE_URL;
const AIRIA_PROMPT_PIPELINE_URL = process.env.AIRIA_PROMPT_PIPELINE_URL;
const AIRIA_USER_ID = process.env.AIRIA_USER_ID;
const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY is not set. The frontend will fail when calling OpenAI.');
}
if (!AIRIA_API_KEY) {
  console.warn('AIRIA_API_KEY is not set. Prompt generation will fail.');
}
if (!AIRIA_PIPELINE_URL) {
  console.warn('AIRIA_PIPELINE_URL is not set. Dream analysis will fail.');
}
if (!AIRIA_PROMPT_PIPELINE_URL) {
  console.warn('AIRIA_PROMPT_PIPELINE_URL is not set. Prompt generation endpoint is disabled.');
}
if (!FREEPIK_API_KEY) {
  console.warn('FREEPIK_API_KEY is not set. Video generation will fail.');
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/realtime' });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'web')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.post('/api/transcribe', async (req, res) => {
  try {
    const { audioBase64 } = req.body;
    if (!audioBase64) {
      return res.status(400).json({ error: 'No audio data provided' });
    }

    // Write base64 audio to temp file
    const tempPath = path.join('/tmp', `audio-${Date.now()}.wav`);
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    fs.writeFileSync(tempPath, audioBuffer);

    const FormDataNode = require('form-data');
    const formData = new FormDataNode();
    formData.append('file', fs.createReadStream(tempPath), {
      filename: 'audio.wav',
      contentType: 'audio/wav',
    });
    formData.append('model', 'whisper-1');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    // Clean up temp file
    try {
      fs.unlinkSync(tempPath);
    } catch (e) {
      console.warn('Could not delete temp file:', e.message);
    }

    if (!response.ok) {
      const error = await response.text();
      console.error('Whisper transcription error:', error);
      return res.status(500).json({ error: 'Transcription failed' });
    }

    const data = await response.json();
    res.json({ text: data.text });
  } catch (error) {
    console.error('Transcribe endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.6,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('OpenAI chat error:', error);
      return res.status(500).json({ error: 'OpenAI chat error' });
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message?.content ?? '';
    res.json({ message });
  } catch (error) {
    console.error('Chat endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/prompt', async (req, res) => {
  if (!AIRIA_PROMPT_PIPELINE_URL || !AIRIA_API_KEY) {
    return res.status(500).json({ error: 'Prompt pipeline is not configured' });
  }

  try {
    const { analysis, userInput, asyncOutput = false, userId } = req.body || {};
    const payloadSource = userInput ?? analysis;
    if (!payloadSource) {
      return res.status(400).json({ error: 'Provide `analysis` or `userInput` in the request body' });
    }

    const serializedInput = typeof payloadSource === 'string' ? payloadSource : JSON.stringify(payloadSource);
    const pipelinePayload = {
      userInput: serializedInput,
      asyncOutput,
    };

    const resolvedUserId = userId || AIRIA_USER_ID;
    if (resolvedUserId) {
      pipelinePayload.userId = resolvedUserId;
    }

    const response = await fetch(AIRIA_PROMPT_PIPELINE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': AIRIA_API_KEY,
      },
      body: JSON.stringify(pipelinePayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Airia prompt error:', errorText);
      return res.status(500).json({ error: 'Airia prompt pipeline error' });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Prompt endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Freepik video generation helper
async function generateFreepikVideo(prompt, options = {}) {
  const {
    model = 'minimax-hailuo-02-768p',
    duration = 6,
    promptOptimizer = true,
    timeoutSeconds = 600,
    pollInterval = 3,
  } = options;

  const FREEPIK_BASE_URL = 'https://api.freepik.com/v1/ai';
  const endpoint = `${FREEPIK_BASE_URL}/image-to-video/${model}`;
  const headers = {
    'x-freepik-api-key': FREEPIK_API_KEY,
    'Content-Type': 'application/json',
  };

  // Submit video generation task
  const submitResponse = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      prompt,
      duration: String(duration),
      prompt_optimizer: promptOptimizer,
    }),
  });

  if (!submitResponse.ok) {
    const errorText = await submitResponse.text();
    throw new Error(`Freepik submission failed: ${errorText}`);
  }

  const submitData = await submitResponse.json();
  const taskId = submitData.data.task_id;
  const statusEndpoint = `${endpoint}/${taskId}`;

  // Poll for completion
  const startTime = Date.now();
  let status = submitData.data.status || 'PENDING';

  while (status !== 'COMPLETED' && status !== 'FAILED') {
    if (Date.now() - startTime > timeoutSeconds * 1000) {
      throw new Error('Freepik video generation timed out');
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));

    const statusResponse = await fetch(statusEndpoint, {
      headers: { 'x-freepik-api-key': FREEPIK_API_KEY },
    });

    if (!statusResponse.ok) {
      throw new Error('Freepik status check failed');
    }

    const statusData = await statusResponse.json();
    status = statusData.data.status;
    console.log(`Freepik task ${taskId}: ${status}`);
  }

  if (status !== 'COMPLETED') {
    throw new Error(`Freepik task failed with status: ${status}`);
  }

  const finalResponse = await fetch(statusEndpoint, {
    headers: { 'x-freepik-api-key': FREEPIK_API_KEY },
  });
  const finalData = await finalResponse.json();
  const videoUrl = finalData.data.generated?.[0];

  if (!videoUrl) {
    throw new Error('No video URL in Freepik response');
  }

  return {
    taskId,
    status,
    videoUrl,
  };
}

// Generate dream interpretation using OpenAI
async function generateDreamInterpretation(dreamTranscript) {
  const systemPrompt = `You are a compassionate dream interpreter who blends Jungian psychology, symbolism, and modern dream analysis. Provide insightful, meaningful interpretations that:
- Identify key symbols and their potential meanings
- Explore emotional themes and psychological significance
- Connect dream elements to the dreamer's inner world
- Offer thoughtful perspectives without being prescriptive
- Use warm, accessible language

Keep interpretations 2-3 paragraphs, focusing on depth over length.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Provide a thoughtful interpretation of this dream:\n\n${dreamTranscript}` },
      ],
      temperature: 0.8,
      max_tokens: 400,
    }),
  });

  if (!response.ok) {
    throw new Error('OpenAI interpretation generation failed');
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// Generate cinematic video prompt from dream using OpenAI
async function generateVideoPromptFromDream(dreamTranscript) {
  const systemPrompt = `You are a cinematic video prompt generator. Convert dream descriptions into concise, visually stunning prompts optimized for AI video generation. Focus on:
- Vivid visual imagery and atmosphere
- Camera angles and movements
- Lighting and color palette
- Key symbolic elements
- Cinematic mood and pacing

Keep prompts under 200 words and emphasize visual storytelling over narrative details.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Convert this dream into a cinematic video generation prompt:\n\n${dreamTranscript}` },
      ],
      temperature: 0.7,
      max_tokens: 300,
    }),
  });

  if (!response.ok) {
    throw new Error('OpenAI prompt generation failed');
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || dreamTranscript;
}

// Submit dream endpoint - full pipeline orchestration
app.post('/api/submit-dream', async (req, res) => {
  try {
    console.log('Received submit-dream request:', { body: req.body });
    const { transcript, duration = 5, model = 'seedance-lite-480p', skipAiria = true } = req.body;

    if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
      console.error('Invalid transcript:', transcript);
      return res.status(400).json({ error: 'transcript is required' });
    }

    console.log('Transcript:', transcript.substring(0, 100) + '...');

    if (!FREEPIK_API_KEY) {
      return res.status(500).json({ error: 'Freepik API key is not configured' });
    }

    let interpretation = '';
    let videoPrompt = transcript;
    let promptSource = 'openai_gpt4o_mini';

    // Step 1: Generate dream interpretation using OpenAI
    try {
      console.log('Step 1: Generating dream interpretation with OpenAI...');
      interpretation = await generateDreamInterpretation(transcript);
      console.log('Generated interpretation:', interpretation.substring(0, 100) + '...');
    } catch (error) {
      console.warn('OpenAI interpretation generation failed:', error.message);
      interpretation = 'Unable to generate interpretation at this time.';
    }

    // Step 2: Generate cinematic video prompt using OpenAI
    try {
      console.log('Step 2: Generating cinematic video prompt with OpenAI...');
      videoPrompt = await generateVideoPromptFromDream(transcript);
      console.log('Generated prompt:', videoPrompt);
    } catch (error) {
      console.warn('OpenAI prompt generation failed, using raw transcript:', error.message);
      videoPrompt = transcript;
      promptSource = 'raw_transcript';
    }

    // Step 3: Generate video with Freepik
    console.log('Step 3: Generating video with Freepik...');
    const videoResult = await generateFreepikVideo(videoPrompt, { duration, model });

    console.log('Video generation complete:', videoResult);

    // Return complete result
    res.json({
      interpretation,
      prompt: videoPrompt,
      promptSource,
      video: videoResult,
    });
  } catch (error) {
    console.error('Submit dream error:', error);
    res.status(500).json({ error: error.message || 'Pipeline execution failed' });
  }
});

wss.on('connection', (ws, req) => {
  console.log('Client connected to realtime proxy');

  // Create connection to OpenAI Realtime API
  const openaiWs = new (require('ws'))('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  let isOpenAIConnected = false;

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime API');
    isOpenAIConnected = true;
  });

  openaiWs.on('message', (data) => {
    // Forward messages from OpenAI to client
    if (ws.readyState === ws.OPEN) {
      ws.send(data.toString());
    }
  });

  openaiWs.on('error', (error) => {
    console.error('OpenAI WebSocket error:', error);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        error: {
          message: 'Failed to connect to OpenAI Realtime API',
          type: 'api_error'
        }
      }));
    }
  });

  openaiWs.on('close', () => {
    console.log('OpenAI WebSocket connection closed');
    isOpenAIConnected = false;
    if (ws.readyState === ws.OPEN) {
      ws.close();
    }
  });

  ws.on('message', (data) => {
    // Forward messages from client to OpenAI
    if (isOpenAIConnected && openaiWs.readyState === openaiWs.OPEN) {
      openaiWs.send(data.toString());
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    if (openaiWs.readyState === openaiWs.OPEN) {
      openaiWs.close();
    }
  });

  ws.on('error', (error) => {
    console.error('Client WebSocket error:', error);
    if (openaiWs.readyState === openaiWs.OPEN) {
      openaiWs.close();
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`DreamPulse UI server listening on http://localhost:${PORT}`);
});
