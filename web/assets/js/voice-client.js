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

  stop() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.lastSpeechAt) {
      this._send({ type: 'input_audio_buffer.commit' });
      if (!this.waitingForResponse) {
        this._createResponse();
      }
    }
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
    this.callbacks.status('Voice session ended.');
  }

  async _connectSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}${WS_PATH}`;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => {
        this.connected = true;
        this.callbacks.status('Connected to realtime session.');
        this._send({
          type: 'session.update',
          session: {
            instructions: this.instructions,
            voice: this.voice,
          },
        });
        this._createResponse('Introduce yourself and invite the dreamer to share.');
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
    switch (message.type) {
      case 'response.audio.delta':
        if (message.delta) {
          this._playAudio(message.delta);
        }
        break;
      case 'response.audio_transcript.delta':
        if (message.delta) {
          this.callbacks.transcript({ speaker: 'assistant', text: message.delta });
        }
        break;
      case 'input_audio_transcription.completed':
        if (message.transcript) {
          this.callbacks.transcript({ speaker: 'user', text: message.transcript });
        }
        break;
      case 'response.created':
        this.waitingForResponse = true;
        break;
      case 'response.completed':
      case 'response.done':
        this.waitingForResponse = false;
        break;
      case 'error':
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
    const input = event.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    let maxAmplitude = 0;
    for (let i = 0; i < input.length; i += 1) {
      const v = Math.max(-1, Math.min(1, input[i]));
      if (Math.abs(v) > maxAmplitude) {
        maxAmplitude = Math.abs(v);
      }
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    this._send({ type: 'input_audio_buffer.append', audio: toBase64Bytes(pcm) });
    const now = Date.now();
    if (maxAmplitude > this.speechThreshold) {
      this.lastSpeechAt = now;
    }
    if (!this.lastCommitAt) {
      this.lastCommitAt = now;
    }
    const enoughSilence = this.lastSpeechAt && now - this.lastSpeechAt >= this.silenceHoldMs;
    if (enoughSilence && now - this.lastCommitAt >= this.commitIntervalMs) {
      this._send({ type: 'input_audio_buffer.commit' });
      if (!this.waitingForResponse) {
        this._createResponse();
      }
      this.lastCommitAt = now;
      this.lastSpeechAt = 0;
    }
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
}
