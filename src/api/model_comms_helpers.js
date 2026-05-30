const { extractImages, formatImagesForAPI } = require('../session/images');
const { probeVisionSupport } = require('../vision/vision_capability_probe');

function prepareVisionMessages(config, messages) {
  const probe = probeVisionSupport(config);
  let firstImagePath = null;
  let hasImages = false;

  const lastUserIdx = messages.length > 0
    ? messages.reduce((last, m, i) => m.role === 'user' ? i : last, -1)
    : -1;
  const processedWithImages = messages.map((msg, idx) => {
    if (msg.role !== 'user' || typeof msg.content !== 'string') return msg;
    if (idx !== lastUserIdx) return msg;
    const images = extractImages(msg.content, process.cwd());
    if (images.length > 0) {
      hasImages = true;
      firstImagePath = images[0].path;
    }
    if (images.length === 0 || !probe.supported) return msg;
    return {
      ...msg,
      content: [
        { type: 'text', text: msg.content },
        ...formatImagesForAPI(images),
      ],
    };
  });

  return { processedWithImages, hasImages, firstImagePath, probeSupported: probe.supported };
}

function startSpinner(fullscreenRef) {
  let _spinnerInterval = null;
  let _spinnerElapsed = 0;
  const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  if (!fullscreenRef && process.stdout.isTTY) {
    let _spinFrame = 0;
    _spinnerInterval = setInterval(() => {
      _spinnerElapsed += 100;
      const secs = (_spinnerElapsed / 1000).toFixed(1);
      process.stdout.write(`\r  ${SPINNER_FRAMES[_spinFrame % SPINNER_FRAMES.length]} Waiting for model... ${secs}s \r`);
      _spinFrame++;
    }, 100);
  } else if (fullscreenRef) {
    let _spinFrame = 0;
    _spinnerInterval = setInterval(() => {
      _spinnerElapsed += 200;
      fullscreenRef.setStatus?.(`${SPINNER_FRAMES[_spinFrame % SPINNER_FRAMES.length]} thinking ${(_spinnerElapsed / 1000).toFixed(0)}s`);
      _spinFrame++;
    }, 200);
  }
  
  return function stopSpinner() {
    if (_spinnerInterval) {
      clearInterval(_spinnerInterval);
      _spinnerInterval = null;
      if (!fullscreenRef && process.stdout.isTTY) {
        process.stdout.write('\r' + ' '.repeat(50) + '\r');
      } else if (fullscreenRef) {
        fullscreenRef.setStatus?.('');
      }
    }
  };
}

async function streamOpenAI(baseUrl, target, systemPrompt, message, headers, options) {
  const { logEvent, EVENT_TYPES } = options;
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: target.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        stream: true,
        temperature: 0.1,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.log(`  ✗ LM Studio error: ${response.status} ${err.slice(0, 200)}`);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') { console.log(''); return; }
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            process.stdout.write(delta.content);
          }
        } catch {}
      }
    }
    console.log('');
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
    if (logEvent) {
      logEvent(EVENT_TYPES?.ERROR || 'error', {
        phase: 'sendToModelOpenAI',
        message: err.message,
        stackSummary: err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : '',
      });
    }
  }
}

async function streamOllama(baseUrl, target, systemPrompt, message, options) {
  const { logEvent, EVENT_TYPES } = options;
  try {
    const host = baseUrl.replace(/\/v1$/, '') || process.env.OLLAMA_HOST || 'http://localhost:11434';
    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: target.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        stream: true,
      }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.message?.content) {
            process.stdout.write(chunk.message.content);
          }
          if (chunk.done) { console.log(''); return; }
        } catch {}
      }
    }
    console.log('');
  } catch (err) {
    console.log(`  ✗ Ollama error: ${err.message}`);
    if (logEvent) {
      logEvent(EVENT_TYPES?.ERROR || 'error', {
        phase: 'sendToModelOllama',
        message: err.message,
        stackSummary: err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : '',
      });
    }
  }
}

module.exports = {
  prepareVisionMessages,
  startSpinner,
  streamOpenAI,
  streamOllama
};
