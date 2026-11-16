// Función de servidor (Vercel). Recibe { input, images } desde la página, llama a la IA con la
// API key guardada como variable de entorno y devuelve { text }. La key NUNCA llega al navegador.
//
// Variables de entorno:
//   GEMINI_API_KEY     → usa Google Gemini (capa gratuita)        [recomendado]
//   ANTHROPIC_API_KEY  → usa Claude (de pago); solo se usa si no hay GEMINI_API_KEY
//   ACCESS_CODE        → (opcional) clave que la página pide a quien la usa
//   MODEL              → (opcional) nombre del modelo, para cambiarlo sin tocar el código
const SYSTEM =
  'Eres el motor de PHYSIONEX, un tutor de física universitaria. Atiende únicamente solicitudes de física ' +
  '(incluye generar preguntas o exámenes de física). Si la solicitud no es de física, responde exactamente: FUERA_DE_TEMA.';

class ApiError extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Una sola llamada a un modelo de Gemini (máximo 35 s; si tarda más, se corta y se prueba otra cosa).
async function geminiOnce(model, input, images, thinking) {
  const generationConfig = { maxOutputTokens: 6000 };
  if (thinking) generationConfig.thinkingConfig = { thinkingBudget: 1024 }; // limita cuánto "piensa" antes de escribir
  let r;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      signal: AbortSignal.timeout(35000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [...images.map((d) => ({ inlineData: { mimeType: 'image/jpeg', data: String(d) } })), { text: input }] }],
        generationConfig,
      }),
    });
  } catch (e) {
    throw new ApiError(504, 'Gemini tardó demasiado en responder. Inténtalo de nuevo.');
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 429) throw new ApiError(429, 'Se alcanzó el límite del plan gratuito. Espera un minuto e inténtalo de nuevo.');
  if (r.status === 503 || r.status === 500) throw new ApiError(503, 'Gemini está saturado en este momento. Inténtalo de nuevo en unos minutos.');
  if (r.status === 400 && thinking) throw new ApiError(400, 'sin_thinking'); // el modelo no acepta el ajuste: se reintenta sin él
  if (!r.ok) throw new ApiError(502, (j.error && j.error.message) || 'Error de Gemini');
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || '').join('');
  if (!text) throw new ApiError(502, 'Gemini no devolvió texto (¿contenido bloqueado?).');
  return text;
}

// Prueba el modelo principal y, si está saturado, tarda demasiado o se acabó su cuota,
// pasa a uno más ligero (que suele estar menos ocupado). Nunca pasa de ~80 s en total.
async function callGemini(input, images) {
  const models = [process.env.MODEL || 'gemini-flash-latest', 'gemini-flash-lite-latest'];
  const t0 = Date.now();
  let last;
  for (const model of models) {
    let thinking = true;
    for (let intento = 0; intento < 2; intento++) {
      if (Date.now() - t0 > 80000) throw last || new ApiError(504, 'Gemini tardó demasiado en responder.');
      try {
        return await geminiOnce(model, input, images, thinking);
      } catch (e) {
        last = e;
        if (e.status === 400 && e.message === 'sin_thinking') { thinking = false; intento--; continue; }
        if (e.status === 429 || e.status === 504) break; // cuota agotada o muy lento: siguiente modelo
        if (e.status !== 503) throw e;
        await sleep(1500);
      }
    }
  }
  throw last;
}

async function callClaude(input, images) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: process.env.MODEL || 'claude-sonnet-5-5', max_tokens: 4000, system: SYSTEM,
      messages: [{ role: 'user', content: [...images.map((d) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: String(d) } })), { type: 'text', text: input }] }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(502, (j.error && j.error.message) || 'Error de Claude');
  return j.content.map((c) => c.text || '').join('');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const code = process.env.ACCESS_CODE;
  if (code && req.headers['x-access-code'] !== code) return res.status(401).json({ error: 'access_code' });

  const { input, images = [] } = req.body || {};
  if (typeof input !== 'string' || !input || input.length > 60000 || !Array.isArray(images) || images.length > 4)
    return res.status(400).json({ error: 'bad_request' });

  try {
    if (process.env.GEMINI_API_KEY) return res.status(200).json({ text: await callGemini(input, images) });
    if (process.env.ANTHROPIC_API_KEY) return res.status(200).json({ text: await callClaude(input, images) });
    return res.status(500).json({ error: 'server', detail: 'Falta GEMINI_API_KEY en las variables de entorno.' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: 'upstream', detail: e.message });
  }
};
