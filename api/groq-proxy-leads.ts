import Groq from 'groq-sdk';

// Типы для Vercel (можно заменить на импорты из @vercel/node, если установлены)
type VercelRequest = any;
type VercelResponse = any;

export const config = {
  runtime: 'nodejs',
};

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

// Модели по приоритету: начинаем с быстрой, переходим к умной, если сбой
const MODEL_FALLBACKS = [
  'llama-3.1-8b-instant',    // Быстрая и дешевая
  'llama-3.3-70b-versatile', // Умная (резерв)
  'mixtral-8x7b-32768',      // Стабильная (резерв)
];

const RETRIES_PER_MODEL = 2;

// НОВЫЙ СТРОГИЙ ПРОМТ (ОДНО ПРЕДЛОЖЕНИЕ)
const SYSTEM_PROMPT = `
Твоя задача — классифицировать сообщение и вернуть JSON {"is_lead": boolean, "reason": string}: ставь "is_lead": true ТОЛЬКО в том случае, если текст содержит явное и недвусмысленное намерение автора нанять разработчика или заплатить за конкретную задачу прямо сейчас (ключевые слова: "нужен", "ищу", "требуется", "заказ", "бюджет", "кто сделает"); во всех остальных случаях (простые вопросы "актуально?", уточнения "цена?", приветствия, обсуждения, реклама своих услуг) строго ставь false.
`.trim();

// Простой список стоп-фраз для мгновенного отсева без AI
const INSTANT_FAIL_PATTERNS = [
  /^актуально\??$/i,
  /^цена\??$/i,
  /^привет\??$/i,
  /^ку\??$/i,
  /^а что набрал\??$/i,
  /^конечно\)?$/i,
  /^спс$/i,
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = (typeof req.body === 'object' && req.body !== null) ? req.body : {};
    const { text } = body as { text?: string };

    // 1. ЖЕСТКАЯ ПРЕ-ВАЛИДАЦИЯ
    if (typeof text !== 'string' || !text.trim()) {
       return res.status(200).json({ ok: true, is_lead: false, reason: 'Empty text' });
    }

    const cleanText = text.trim();

    // Если текст короче 10 символов — проверяем на явный мусор
    if (cleanText.length < 10) {
      for (const pattern of INSTANT_FAIL_PATTERNS) {
        if (pattern.test(cleanText)) {
          return res.status(200).json({
            ok: true,
            is_lead: false,
            reason: 'Hardcoded filter (short text)',
          });
        }
      }
    }
    
    // Если текст совсем короткий (менее 3 символов), тоже отсекаем
    if (cleanText.length < 3) {
        return res.status(200).json({
            ok: true,
            is_lead: false,
            reason: 'Text too short',
        });
    }

    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: cleanText },
    ];

    // 2. ЦИКЛ ЗАПРОСОВ К GROQ
    for (let modelIdx = 0; modelIdx < MODEL_FALLBACKS.length; modelIdx++) {
      const model = MODEL_FALLBACKS[modelIdx];
      
      for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
        try {
          const completion = await groq.chat.completions.create({
            model,
            messages,
            max_tokens: 120, // Уменьшили, нам нужен только JSON
            temperature: 0.0, // Строгий детерминизм
            response_format: { type: 'json_object' }
          });

          const content = completion.choices[0]?.message?.content ?? '';
          
          let parsed: any = null;
          try {
            const jsonStart = content.indexOf('{');
            const jsonEnd = content.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1) {
                parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
            } else {
                // Если модель вернула не JSON, считаем это отказом
                console.warn(`[${model}] No JSON found in response`);
                throw new Error("No JSON found");
            }
          } catch (e) {
            console.warn(`[${model}] JSON parse failed:`, content);
            throw new Error("Invalid JSON format");
          }

          // Успешный ответ
          return res.status(200).json({
            ok: true,
            model, // Полезно для отладки, видеть кто ответил
            is_lead: Boolean(parsed.is_lead),
            reason: String(parsed.reason ?? 'No reason provided'),
          });

        } catch (err: any) {
          console.error(`Error with model ${model}, attempt ${attempt}:`, err.message);
          
          const status = err.status ?? err.response?.status;
          
          // Если 429 (Rate Limit), сразу меняем модель
          if (status === 429 || err.code === 'rate_limit_exceeded') break; 
          
          // Если 500+, ждем и пробуем ту же модель
          if (status >= 500 && attempt < RETRIES_PER_MODEL) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          
          // Иначе меняем модель
          break;
        }
      }
    }

    // 3. ЕСЛИ ВСЕ МОДЕЛИ УПАЛИ
    return res.status(503).json({
      ok: false,
      error: 'All models failed or exhausted retries',
    });

  } catch (e: any) {
    console.error('FATAL_HANDLER_ERROR', e);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}
