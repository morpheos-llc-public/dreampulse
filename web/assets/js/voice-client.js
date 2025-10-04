const WS_PATH = '/realtime';

function toBase64Bytes(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export class RealtimeVoiceClient {
  constructor({ instructions, voice = 'alloy', commitIntervalMs = 1800 }) {
    this.instructions = instructions;
    this.voice = voice;
    this.sampleRate = 24000;
    this.commitIntervalMs = commitIntervalMs;
    this.connected = false;
    this.ws = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.nextPlaybackTime = 0;
    this.lastCommitAt = 0;
    this.lastSpeechAt = 0;
    this.speechThreshold = 0.02;
    this.silenceHoldMs = 1200;
    this.waitingForResponse = false;
    this.currentAssistantTranscript = '';
    this.pendingUserItemIds = new Set();
    this.recordedAudioChunks = [];
    this.callbacks = {
      status: () => {},
      transcript: () => {},
      error: () => {},
    };
  }

  setVoice(voice) {
    this.voice = voice;
    if (this.connected) {
      this._send({ type: 'session.update', session: { voice } });
    }
  }

  setInstructions(instructions) {
    this.instructions = instructions;
    if (this.connected) {
      this._send({ type: 'session.update', session: { instructions } });
    }
  }

  onStatus(fn) {
    this.callbacks.status = fn;
  }

  onTranscript(fn) {
    this.callbacks.transcript = fn;
  }

  onError(fn) {
    this.callbacks.error = fn;
  }

  async start() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: this.sampleRate });
    }
    if (!this.mediaStream) {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: this.sampleRate,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processorNode = this.audioContext.createScriptProcessor(1024, 1, 1);
    this.processorNode.onaudioprocess = (event) => this._handleAudio(event);
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);

    await this._connectSocket();
  }

  startPushToTalk() {
    // Enable audio sending and start recording
    this.isPushToTalkActive = true;
    this.recordedAudioChunks = [];
    this.callbacks.status('Recording...');
  }

  async endPushToTalk() {
    // Commit audio and request response
    this.isPushToTalkActive = false;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._send({ type: 'input_audio_buffer.commit' });
      if (!this.waitingForResponse) {
        this._createResponse();
      }

      // Transcribe the recorded audio via Whisper
      if (this.recordedAudioChunks.length > 0) {
        this._transcribeRecordedAudio();
      }
    }
    this.callbacks.status('Processing...');
  }

  stop() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode.onaudioprocess = null;
      this.processorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    this.nextPlaybackTime = 0;
    this.lastCommitAt = 0;
    this.lastSpeechAt = 0;
    this.waitingForResponse = false;
    this.connected = false;
    this.isPushToTalkActive = false;
    this.currentAssistantTranscript = '';
    this.callbacks.status('Voice session ended.');
  }

  async _connectSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}${WS_PATH}`;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => {
        this.connected = true;
        this.callbacks.status('Waiting for session...');
        this._send({
          type: 'session.update',
          session: {
            voice: this.voice,
            modalities: ['text', 'audio'],
            input_audio_transcription: {
              model: 'whisper-1'
            },
            turn_detection: null
          },
        });
        resolve();
      };

      this.ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        this._handleMessage(message);
      };

      this.ws.onerror = (event) => {
        this.callbacks.error(new Error('Realtime socket error'));
        reject(event);
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.callbacks.status('Realtime session closed.');
      };
    });
  }

  _handleMessage(message) {
    console.log('Received message type:', message.type);

    // Log all transcription-related events for debugging
    if (message.type.includes('transcription') || message.type.includes('audio_buffer')) {
      console.log('Audio/Transcription event details:', JSON.stringify(message, null, 2));
    }

    switch (message.type) {
      case 'session.created':
        console.log('Session created:', message);
        // Send system instructions as conversation item
        this._send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: this.instructions }]
          }
        });
        break;
      case 'session.updated':
        console.log('Session updated:', message);
        break;
      case 'conversation.item.created':
        console.log('Conversation item created:', message.item?.role);
        if (message.item?.role === 'system') {
          // System message added successfully, now create initial greeting
          this.callbacks.status('Connected and ready');
          this._createResponse('');
        } else if (message.item?.role === 'user') {
          // User message created - transcript won't be available yet with push-to-talk
          // We'll extract it from the assistant's response context later
          console.log('User item created, ID:', message.item?.id);
          if (message.item?.id) {
            this.pendingUserItemIds.add(message.item.id);
          }
        }
        break;
      case 'response.output_item.added':
        // When assistant responds, we can infer what the user said from context
        console.log('Response output item added');
        break;
      case 'response.text.delta':
      case 'response.text.done':
        // These events might contain text versions of what was said
        console.log('Response text event:', message.type, message);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        console.log('Input audio transcription completed:', message);
        if (message.transcript) {
          console.log('User said (from transcription event):', message.transcript);
          this.callbacks.transcript({ speaker: 'user', text: message.transcript });
        }
        break;
      case 'response.audio.delta':
        if (message.delta) {
          console.log('Received audio delta');
          this._playAudio(message.delta);
        }
        break;
      case 'response.audio_transcript.delta':
        if (message.delta) {
          this.currentAssistantTranscript += message.delta;
        }
        break;
      case 'response.audio_transcript.done':
        if (this.currentAssistantTranscript.trim()) {
          console.log('Assistant said:', this.currentAssistantTranscript);
          this.callbacks.transcript({
            speaker: 'assistant',
            text: this.currentAssistantTranscript.trim()
          });
          this.currentAssistantTranscript = '';
        }
        break;
      case 'conversation.item.input_audio_transcription.completed':
      case 'input_audio_transcription.completed':
        console.log('Transcription event:', message.type, message);
        if (message.transcript) {
          console.log('User said:', message.transcript);
          this.callbacks.transcript({ speaker: 'user', text: message.transcript });
        }
        break;
      case 'response.created':
        console.log('Response being generated...');
        this.waitingForResponse = true;
        break;
      case 'response.completed':
      case 'response.done':
        console.log('Response completed');
        this.waitingForResponse = false;
        break;
      case 'error':
        console.error('Realtime API error:', message.error);
        this.callbacks.error(new Error(message.error?.message || 'Realtime error'));
        break;
      default:
        break;
    }
  }

  _handleAudio(event) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    // Only send audio when push-to-talk is active
    if (!this.isPushToTalkActive) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const v = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }

    // Store audio for transcription
    this.recordedAudioChunks.push(new Int16Array(pcm));

    this._send({ type: 'input_audio_buffer.append', audio: toBase64Bytes(pcm) });
  }

  _playAudio(base64) {
    if (!this.audioContext) {
      return;
    }
    const audioBuffer = fromBase64(base64);
    const int16 = new Int16Array(audioBuffer);
    if (int16.length === 0) {
      return;
    }
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i += 1) {
      float32[i] = int16[i] / 0x8000;
    }
    const buffer = this.audioContext.createBuffer(1, float32.length, this.sampleRate);
    buffer.getChannelData(0).set(float32);
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);
    const startAt = Math.max(this.audioContext.currentTime, this.nextPlaybackTime);
    this.nextPlaybackTime = startAt + buffer.duration;
    source.start(startAt);
  }

  _createResponse(instructions = '') {
    this.waitingForResponse = true;
    this._send({
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions,
      },
    });
  }

  _send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  _extractTranscriptFromItem(item) {
    // Extract transcript from conversation item
    // Item structure: { content: [{ type: 'input_audio', transcript: '...' }] }
    if (!item || !item.content || !Array.isArray(item.content)) {
      return '';
    }

    for (const content of item.content) {
      if (content.type === 'input_audio' && content.transcript) {
        return content.transcript;
      }
    }

    return '';
  }

  async _transcribeRecordedAudio() {
    try {
      // Combine all audio chunks into a single array
      const totalLength = this.recordedAudioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const combinedAudio = new Int16Array(totalLength);
      let offset = 0;
      for (const chunk of this.recordedAudioChunks) {
        combinedAudio.set(chunk, offset);
        offset += chunk.length;
      }

      // Convert to base64 WAV
      const wavBlob = this._int16ToWav(combinedAudio, this.sampleRate);
      const reader = new FileReader();

      reader.onloadend = async () => {
        const base64Audio = reader.result.split(',')[1];

        const response = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audioBase64: base64Audio }),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.text) {
            console.log('User said (from Whisper):', data.text);
            this.callbacks.transcript({ speaker: 'user', text: data.text });
          }
        } else {
          console.error('Transcription failed:', await response.text());
        }
      };

      reader.readAsDataURL(wavBlob);
    } catch (error) {
      console.error('Transcription error:', error);
    }
  }

  _int16ToWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    // WAV header
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    // Write audio data
    for (let i = 0; i < samples.length; i++) {
      view.setInt16(44 + i * 2, samples[i], true);
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }
}
