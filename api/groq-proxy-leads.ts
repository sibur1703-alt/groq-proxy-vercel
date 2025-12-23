import Groq from 'groq-sdk';

type VercelRequest = any;
type VercelResponse = any;

export const config = {
  runtime: 'nodejs',
};

const groqKeys = [
  process.env.GROQ_API_KEY_1!,
  process.env.GROQ_API_KEY_2!,
].filter(Boolean);

const groqClients = groqKeys.map(key => new Groq({ apiKey: key }));

// DeepSeek — бесплатный + мощный для классификации
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY!;

const MODEL_FALLBACKS = [
  'llama-3.3-70b-versatile', // Groq топ
  'mixtral-8x7b-32768',      // Groq резерв
  'deepseek/deepseek-chat',  // Бесплатный зверь
];

const RETRIES_PER_MODEL = 2;

const SYSTEM_PROMPT = `
Твоя роль: Жесткий фильтр спама и флуда.
Твоя задача: Найти сообщения, где автор ЯВНО хочет НАНЯТЬ специалиста за ДЕНЬГИ.

Правило: Если есть сомнения -> "is_lead": false.

ПРИМЕРЫ (ОБУЧЕНИЕ):
- "Еще..." -> false (Мусор)
- "Чем на русском..." -> false (Мусор)
- "А данные самое важное..." -> false (Мусор, просто мнение)
- "Нужен бот, пишите" -> true (Заказ)
- "Ищу разработчика, плачу" -> true (Заказ)

Верни JSON: {"is_lead": boolean, "reason": string}
`.trim();

async function callGroq(client: Groq, model: string, messages: any[]) {
  return client.chat.completions.create({
    model,
    messages,
    max_tokens: 100,
    temperature: 0,
    response_format: { type: 'json_object' }
  });
}

async function callDeepSeek(messages: any[]) {
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DEEPSEEK_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      max_tokens: 100,
      temperature: 0,
      response_format: { type: 'json_object' }
    })
  });
  return response.json();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = (typeof req.body === 'object' && req.body !== null) ? req.body : {};
    const { text } = body as { text?: string };

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(200).json({ ok: true, is_lead: false, reason: 'Empty' });
    }
    
    const cleanText = text.trim();
    if (cleanText.length < 15) {
      return res.status(200).json({
        ok: true,
        is_lead: false,
        reason: 'Text too short (<15 chars)',
      });
    }

    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: cleanText },
    ];

    // 1. Пробуем все Groq ключи + модели
    for (let clientIdx = 0; clientIdx < groqClients.length; clientIdx++) {
      const client = groqClients[clientIdx];
      console.log(`[Groq ${clientIdx + 1}] Trying models...`);
      
      for (let modelIdx = 0; modelIdx < MODEL_FALLBACKS.length - 1; modelIdx++) { // -1 исключает DeepSeek
        const model = MODEL_FALLBACKS[modelIdx];
        
        for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
          try {
            const completion = await callGroq(client, model, messages);
            const content = completion.choices[0]?.message?.content ?? '';
            const parsed = JSON.parse(content);

            console.log(`[${model}] SUCCESS`);
            return res.status(200).json({
              ok: true,
              model,
              is_lead: Boolean(parsed.is_lead),
              reason: String(parsed.reason ?? ''),
            });
          } catch (err: any) {
            console.log(`[${model}] attempt ${attempt + 1} failed:`, err.message);
            if (attempt === RETRIES_PER_MODEL) break;
            await new Promise(r => setTimeout(r, 1000)); // 1s backoff
          }
        }
      }
    }

    // 2. Финальный фоллбэк: DeepSeek (бесплатный)
    console.log('[DeepSeek] Final fallback...');
    try {
      const deepseekResult = await callDeepSeek(messages);
      const content = deepseekResult.choices[0]?.message?.content ?? '';
      const parsed = JSON.parse(content);

      console.log('[deepseek-chat] SUCCESS');
      return res.status(200).json({
        ok: true,
        model: 'deepseek-chat',
        is_lead: Boolean(parsed.is_lead),
        reason: String(parsed.reason ?? ''),
      });
    } catch (err: any) {
      console.error('[DeepSeek] FAILED:', err.message);
    }

    return res.status(503).json({ 
      ok: false, 
      error: 'All models exhausted' 
    });

  } catch (e: any) {
    console.error('FATAL_HANDLER_ERROR:', e);
    return res.status(500).json({ error: e.message });
  }
}
