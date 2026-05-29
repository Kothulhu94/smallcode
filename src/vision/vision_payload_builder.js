// SmallCode — Vision Payload Builder
// Formats images into base64 data URLs for OpenAI-compatible multimodal payloads and executes endpoint requests.

const fs = require('fs');
const { probeVisionSupport } = require('./vision_capability_probe');
const { buildAuthHeaders, getModelTarget, withModelTarget } = require('../../bin/config');

/**
 * Builds the multimodal OpenAI-compatible message payload.
 * @param {string} text - User prompt or question
 * @param {string} imagePath - Path to the local image
 * @returns {Array<object>} Message content array
 */
function buildVisionPayload(text, imagePath) {
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }
  const buffer = fs.readFileSync(imagePath);
  const base64 = buffer.toString('base64');
  
  // Format as data URL (assuming PNG)
  const dataUrl = `data:image/png;base64,${base64}`;
  
  return [
    {
      type: 'text',
      text
    },
    {
      type: 'image_url',
      image_url: {
        url: dataUrl
      }
    }
  ];
}

/**
 * Executes a query containing image + text against the active model endpoint.
 * @param {object} params
 * @param {string} params.text - The query or question
 * @param {string} params.imagePath - Path to the screenshot/image file
 * @param {object} params.config - Harness configuration object
 * @returns {Promise<object>} Returns { success: true, text: string } or the required structured error
 */
async function queryVisionModel({ text, imagePath, config }) {
  const probe = probeVisionSupport(config);
  
  if (!probe.supported) {
    return {
      error: "Vision input is not supported by the active model endpoint",
      imagePath,
      hint: "Screenshot was captured/stored, but the active model endpoint cannot analyze images."
    };
  }

  const target = config.activeModelTarget || getModelTarget(config, 'default');
  const requestConfig = withModelTarget(config, target);
  const baseUrl = target.baseUrl;
  const headers = buildAuthHeaders(requestConfig);

  try {
    const content = buildVisionPayload(text, imagePath);
    const body = {
      model: target.model,
      messages: [
        {
          role: 'user',
          content
        }
      ],
      temperature: 0.2,
      max_tokens: 1024
    };

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        error: `API error ${response.status}: ${errText.slice(0, 200)}`,
        imagePath,
        hint: "Model API endpoint rejected the request. Check your base URL or model settings."
      };
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || '';
    return {
      success: true,
      text: reply.trim()
    };
  } catch (err) {
    return {
      error: `Network/API connection failed: ${err.message}`,
      imagePath,
      hint: "Ensure your local model server (e.g. KoboldCPP or LM Studio) is running and reachable."
    };
  }
}

module.exports = {
  buildVisionPayload,
  queryVisionModel
};
