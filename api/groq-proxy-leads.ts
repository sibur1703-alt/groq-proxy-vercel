import Groq from 'groq-sdk';

type VercelRequest = any;
type VercelResponse = any;

export const config = {
  runtime: 'nodejs',
};

// ---------- GROQ КЛЮЧИ ----------
const groqKeys = [
  process.env.GROQ_API_KEY_1!,
  process.env.GROQ_API_KEY_2!,
].filter(Boolean);

const groqClients = groqKeys.map((key) => new Groq({ apiKey: key }));

// ---------- CEREBRAS КЛЮЧИ ----------
const cerebrasKeys = [
  process.env.CEREBRAS_1!,
  process.env.CEREBRAS_2!,
].filter(Boolean);

// Модели Groq по приоритету
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'mixtral-8x7b-32768',
];

const RETRIES_PER_MODEL = 2;

const SYSTEM_PROMPT = `
Твоя роль: Жесткий фильтр спама и флуда.
Твоя задача: Найти сообщения, где автор ЯВНО хочет НАНЯТЬ специалиста за ДЕНЬГИ.

Правило: Если есть сомнения -> "is_lead": false.

ПРИМЕРЫ:
- "Еще..." -> false
- "Чем на русском..." -> false
- "А данные самое важное..." -> false
- "Нужен бот, пишите" -> true
- "Ищу разработчика, плачу" -> true

Верни JSON: {"is_lead": boolean}
`.trim();

// ---------- ВСПОМОГАТЕЛЬНЫЕ ----------

async function callGroq(client: Groq, model: string, messages: any[]) {
  return client.chat.completions.create({
    model,
    messages,
    max_tokens: 50,
    temperature: 0,
    response_format: { type: 'json_object' },
  });
}

async function callCerebras(key: string, messages: any[]) {
  const resp = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b',
      messages,
      max_tokens: 50,
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Cerebras HTTP ${resp.status}: ${text}`);
  }

  return resp.json();
}

// ---------- ХЭНДЛЕР ----------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = (typeof req.body === 'object' && req.body !== null) ? req.body : {};
    const { text } = body as { text?: string };

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(200).json({ ok: true, is_lead: false, text: '' });
    }

    const cleanText = text.trim();

    // короткий мусор
    if (cleanText.length < 15) {
      return res.status(200).json({
        ok: true,
        is_lead: false,
        text: cleanText,
      });
    }

    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: cleanText },
    ];

    // ----- 1. GROQ: два ключа × модели -----
    for (let cIdx = 0; cIdx < groqClients.length; cIdx++) {
      const client = groqClients[cIdx];

      for (let mIdx = 0; mIdx < GROQ_MODELS.length; mIdx++) {
        const model = GROQ_MODELS[mIdx];

        for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
          try {
            const completion = await callGroq(client, model, messages);
            const content = completion.choices[0]?.message?.content ?? '';
            const parsed = JSON.parse(content);

            return res.status(200).json({
              ok: true,
              model,
              is_lead: Boolean(parsed.is_lead),
              text: cleanText,
            });
          } catch (err: any) {
            const msg = err?.message || String(err);
            console.warn(`[GROQ ${cIdx + 1} ${model}] fail #${attempt + 1}:`, msg);

            if (attempt === RETRIES_PER_MODEL) break;
            await new Promise((r) => setTimeout(r, 800));
          }
        }
      }
    }

    // ----- 2. CEREBRAS: два ключа по очереди -----
    for (let idx = 0; idx < cerebrasKeys.length; idx++) {
      const key = cerebrasKeys[idx];
      if (!key) continue;

      try {
        const result = await callCerebras(key, messages);
        const content = result.choices?.[0]?.message?.content ?? '';
        const parsed = JSON.parse(content);

        return res.status(200).json({
          ok: true,
          model: `cerebras-llama-3.3-70b-${idx + 1}`,
          is_lead: Boolean(parsed.is_lead),
          text: cleanText,
        });
      } catch (err: any) {
        console.error(`[CEREBRAS ${idx + 1}] failed:`, err?.message || String(err));
        continue;
      }
    }

    return res.status(503).json({
      ok: false,
      error: 'All providers failed',
    });
  } catch (e: any) {
    console.error('FATAL_HANDLER_ERROR:', e);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}
