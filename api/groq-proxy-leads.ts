import Groq from 'groq-sdk';

type VercelRequest = any;
type VercelResponse = any;

export const config = {
  runtime: 'nodejs',
};

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

// УБРАЛИ 8B МОДЕЛЬ. ОСТАВИЛИ ТОЛЬКО УМНЫЕ.
const MODEL_FALLBACKS = [
  'llama-3.3-70b-versatile', // Умная, понимает контекст
  'mixtral-8x7b-32768',      // Резерв
];

const RETRIES_PER_MODEL = 2;

// ПРОМТ С ПРИМЕРАМИ (FEW-SHOT) — ЭТО ЕДИНСТВЕННЫЙ СПОСОБ ЗАСТАВИТЬ ЕЁ РАБОТАТЬ
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

    // ---------------------------------------------------------
    // ФИЛЬТР ДЛИНЫ: Если текст < 20 символов, это 100% мусор.
    // Фраза "Нужен бот" (9 симв) слишком коротка и подозрительна.
    // Нормальный заказ: "Нужен бот для тг, пишите" (24 симв).
    // ---------------------------------------------------------
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

    for (let modelIdx = 0; modelIdx < MODEL_FALLBACKS.length; modelIdx++) {
      const model = MODEL_FALLBACKS[modelIdx];
      
      for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
        try {
          const completion = await groq.chat.completions.create({
            model,
            messages,
            max_tokens: 100, 
            temperature: 0, // Строгий ноль
            response_format: { type: 'json_object' }
          });

          const content = completion.choices[0]?.message?.content ?? '';
          const parsed = JSON.parse(content);

          return res.status(200).json({
            ok: true,
            model,
            is_lead: Boolean(parsed.is_lead),
            reason: String(parsed.reason ?? ''),
          });

        } catch (err: any) {
           // Ошибки обработки... (как было)
           if (attempt === RETRIES_PER_MODEL && modelIdx === MODEL_FALLBACKS.length - 1) {
               throw err;
           }
        }
      }
    }
    return res.status(500).json({ error: 'All failed' });

  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
}
