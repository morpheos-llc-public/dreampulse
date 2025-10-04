import { RealtimeVoiceClient } from './voice-client.js';

const chatLog = document.getElementById('chat-log');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatStatus = document.getElementById('chat-status');
const chatReset = document.getElementById('chat-reset');
const chatSubmitDream = document.getElementById('chat-submit-dream');

const voiceSelect = document.getElementById('voice-select');
const voiceStart = document.getElementById('voice-start');
const voiceStop = document.getElementById('voice-stop');
const voiceStatus = document.getElementById('voice-status');
const voiceTranscript = document.getElementById('voice-transcript');
const voiceSubmitDream = document.getElementById('voice-submit-dream');

const resultsPanel = document.getElementById('results-panel');
const resultsLoading = document.getElementById('results-loading');
const resultsVideo = document.getElementById('results-video');
const resultsError = document.getElementById('results-error');
const videoPlayer = document.getElementById('video-player');
const videoSource = document.getElementById('video-source');
const videoDownload = document.getElementById('video-download');
const videoReset = document.getElementById('video-reset');
const errorMessage = document.getElementById('error-message');
const errorRetry = document.getElementById('error-retry');
const analysisDetails = document.getElementById('analysis-details');
const stepAnalysis = document.getElementById('step-analysis');
const stepPrompt = document.getElementById('step-prompt');
const stepVideo = document.getElementById('step-video');

const textSystemPrompt = `You are DreamPulse, a lucid-dream interviewer. Help the dreamer recall sensory details, characters, emotions, and settings from a recent dream. Respond in a warm tone and ask focused follow-up questions until you have enough to build a vivid scene.`;

let conversation = [{ role: 'system', content: textSystemPrompt }];

function appendChatMessage(role, text) {
  const bubble = document.createElement('div');
  bubble.classList.add('message', role === 'assistant' ? 'assistant' : 'user');
  bubble.textContent = text;
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function sendChatMessage(event) {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) {
    return;
  }
  appendChatMessage('user', message);
  conversation.push({ role: 'user', content: message });
  chatInput.value = '';
  setChatBusy(true, 'Calling OpenAI...');

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: conversation }),
    });
    if (!response.ok) {
      throw new Error('OpenAI request failed');
    }
    const data = await response.json();
    const reply = data?.message ?? 'I could not process that, please try again.';
    appendChatMessage('assistant', reply);
    conversation.push({ role: 'assistant', content: reply });
  } catch (error) {
    console.error(error);
    appendChatMessage('assistant', 'Something went wrong reaching OpenAI.');
  } finally {
    setChatBusy(false);
  }
}

function setChatBusy(active, label = '') {
  chatStatus.textContent = label;
  chatInput.disabled = active;
}

function resetChat() {
  conversation = [{ role: 'system', content: textSystemPrompt }];
  chatLog.innerHTML = '';
  chatStatus.textContent = 'Conversation reset.';
}

const voiceInstructions = `You are DreamPulse Voice, a gentle guide who records dreams for later visualization. Keep replies concise, invite descriptive imagery, and acknowledge emotions. When the dreamer pauses, ask about other senses or feelings.`;

const voiceClient = new RealtimeVoiceClient({ instructions: voiceInstructions, voice: voiceSelect.value });

voiceClient.onStatus((message) => {
  voiceStatus.textContent = message;
});

voiceClient.onTranscript(({ speaker, text }) => {
  if (!text?.trim()) {
    return;
  }
  const entry = document.createElement('p');
  entry.innerHTML = `<span class="speaker">${speaker === 'assistant' ? 'DreamPulse' : 'You'}</span><br>${text}`;
  voiceTranscript.appendChild(entry);
  voiceTranscript.scrollTop = voiceTranscript.scrollHeight;
});

voiceClient.onError((error) => {
  console.error(error);
  voiceStatus.textContent = error.message || 'Voice session error';
  voiceStart.disabled = false;
  voiceStop.disabled = true;
});

voiceSelect.addEventListener('change', (event) => {
  voiceClient.setVoice(event.target.value);
});

voiceStart.addEventListener('click', async () => {
  voiceTranscript.innerHTML = '';
  voiceStatus.textContent = 'Initializing microphone...';
  voiceStart.disabled = true;
  try {
    await voiceClient.start();
    voiceStop.disabled = false;
  } catch (error) {
    console.error(error);
    voiceStatus.textContent = 'Unable to start voice session. Check console for details.';
    voiceStart.disabled = false;
  }
});

voiceStop.addEventListener('click', () => {
  voiceClient.stop();
  voiceStart.disabled = false;
  voiceStop.disabled = true;
  voiceSubmitDream.disabled = false; // Enable submit after stopping
});

// Extract text transcript from conversation
function extractTextTranscript() {
  return conversation
    .filter(msg => msg.role === 'user')
    .map(msg => msg.content)
    .join('\n');
}

// Extract voice transcript from DOM
function extractVoiceTranscript() {
  const entries = Array.from(voiceTranscript.querySelectorAll('p'));
  return entries
    .map(p => {
      const speaker = p.querySelector('.speaker')?.textContent || '';
      const text = p.textContent.replace(speaker, '').trim();
      return text;
    })
    .filter(text => text.length > 0)
    .join('\n');
}

// Submit dream to pipeline
async function submitDream(transcript, source = 'text') {
  if (!transcript || !transcript.trim()) {
    alert('Please have a conversation about your dream before submitting.');
    return;
  }

  // Show results panel and loading state
  resultsPanel.style.display = 'block';
  resultsLoading.style.display = 'block';
  resultsVideo.style.display = 'none';
  resultsError.style.display = 'none';

  // Reset step indicators
  stepAnalysis.style.opacity = '0.5';
  stepPrompt.style.opacity = '0.5';
  stepVideo.style.opacity = '0.5';

  try {
    // Step 1: Analysis
    stepAnalysis.style.opacity = '1';
    stepAnalysis.textContent = 'Analyzing dream... ⏳';

    const response = await fetch('/api/submit-dream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Pipeline failed');
    }

    stepAnalysis.textContent = 'Dream analyzed ✓';

    // Step 2: Prompt (simulated update based on backend flow)
    stepPrompt.style.opacity = '1';
    stepPrompt.textContent = 'Generating video prompt... ⏳';

    const result = await response.json();

    stepPrompt.textContent = 'Video prompt ready ✓';

    // Step 3: Video
    stepVideo.style.opacity = '1';
    stepVideo.textContent = 'Video generated ✓';

    // Display video
    videoSource.src = result.video.videoUrl;
    videoPlayer.load();
    videoDownload.href = result.video.videoUrl;
    analysisDetails.textContent = JSON.stringify(result, null, 2);

    resultsLoading.style.display = 'none';
    resultsVideo.style.display = 'block';

    // Scroll to results
    resultsPanel.scrollIntoView({ behavior: 'smooth' });
  } catch (error) {
    console.error('Submit dream error:', error);
    stepAnalysis.textContent = 'Analysis failed ✗';
    stepPrompt.textContent = 'Prompt generation skipped ✗';
    stepVideo.textContent = 'Video generation failed ✗';

    errorMessage.textContent = error.message || 'Failed to generate video. Please try again.';
    resultsLoading.style.display = 'none';
    resultsError.style.display = 'block';
  }
}

// Text mode submit handler
chatSubmitDream.addEventListener('click', () => {
  const transcript = extractTextTranscript();
  submitDream(transcript, 'text');
});

// Voice mode submit handler
voiceSubmitDream.addEventListener('click', () => {
  const transcript = extractVoiceTranscript();
  submitDream(transcript, 'voice');
});

// Reset handlers
videoReset.addEventListener('click', () => {
  resultsPanel.style.display = 'none';
  videoPlayer.pause();
  videoSource.src = '';
});

errorRetry.addEventListener('click', () => {
  resultsPanel.style.display = 'none';
});

chatForm.addEventListener('submit', sendChatMessage);
chatReset.addEventListener('click', resetChat);

appendChatMessage('assistant', 'Hi! Ready to capture last night\'s dream? Tell me the scene that stands out first.');
chatStatus.textContent = 'Powered by OpenAI GPT chat.';
