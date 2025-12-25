import Groq from 'groq-sdk';

// Типы для Vercel (чтобы TypeScript не ругался)
type VercelRequest = any;
type VercelResponse = any;

export const config = {
  runtime: 'nodejs',
};

// 1. ИНИЦИАЛИЗАЦИЯ КЛИЕНТОВ (РОТАЦИЯ КЛЮЧЕЙ)
const groqKeys = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
].filter((k): k is string => !!k && k.length > 0);

const groqClients = groqKeys.map((apiKey) => new Groq({ apiKey }));

if (groqClients.length === 0) {
  console.error("NO GROQ API KEYS FOUND! CHECK .ENV");
}

// 2. СПИСОК МОДЕЛЕЙ (ОТ УМНЫХ К БЫСТРЫМ)
const MODEL_FALLBACKS = [
  'llama-3.3-70b-versatile',
  'qwen/qwen-2.5-32b',       
  'llama-3.1-8b-instant',    
];

const RETRIES_PER_MODEL = 2;

// 3. УПРОЩЁННЫЙ ПРОМТ - ТОЛЬКО "ВРУЧНУЮ"
const SYSTEM_PROMPT = `
Твоя роль: Искать слово "вручную" в тексте.

Верни JSON {"found": boolean, "reason": string}.

Правила:
- "found": true ТОЛЬКО если в тексте есть слово "вручную" (любая форма написания)
- "found": false если слова "вручную" нет
`.trim();

// --- ОСНОВНОЙ ХЕНДЛЕР ---
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = (typeof req.body === 'object' && req.body !== null) ? req.body : {};
    const { text } = body as { text?: string };

    if (typeof text !== 'string' || !text.trim()) {
       return res.status(200).json({ ok: true, found: false, reason: 'Empty text' });
    }

    const cleanText = text.trim();

    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: cleanText },
    ];

    let lastError = null;

    for (const model of MODEL_FALLBACKS) {
      const randomClientIdx = Math.floor(Math.random() * groqClients.length);
      const groq = groqClients[randomClientIdx]; 
      
      for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
        try {
          const completion = await groq.chat.completions.create({
            model: model,
            messages,
            max_tokens: 50,
            temperature: 0,
            response_format: { type: 'json_object' }
          });

          const content = completion.choices[0]?.message?.content ?? '';
          const parsed = JSON.parse(content);

          return res.status(200).json({
            ok: true,
            model: model,
            found: Boolean(parsed.found),
            reason: String(parsed.reason || 'No reason'),
          });

        } catch (err: any) {
          lastError = err;
          const status = err.status ?? err.response?.status;
          
          console.warn(`[${model}] Attempt ${attempt} failed: ${err.message}`);

          if (status === 429 || err.code === 'rate_limit_exceeded') {
            break; 
          }
          
          if (status >= 500 && attempt < RETRIES_PER_MODEL) {
            await new Promise((r) => setTimeout(r, 800));
            continue;
          }
          
          break;
        }
      }
    }

    console.error('ALL_MODELS_FAILED', lastError);
    return res.status(503).json({
      ok: false,
      error: 'All AI models failed',
      details: lastError?.message,
    });

  } catch (e: any) {
    console.error('FATAL_HANDLER_ERROR', e);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}
