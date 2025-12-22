import Groq from 'groq-sdk';

// Заглушки типов
type VercelRequest = any;
type VercelResponse = any;

export const config = {
  runtime: 'nodejs',
};

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

// Модели Groq по приоритету
const MODEL_FALLBACKS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
];

const RETRIES_PER_MODEL = 2;

// ОБНОВЛЕННЫЙ ПРОМТ (Без Summary)
const SYSTEM_PROMPT = `
Ты — AI-ассистент для фильтрации коммерческих лидов.
Твоя задача: понять, является ли сообщение ЗАКАЗОМ на разработку (автор платит деньги).

### ТВОЯ ЗАДАЧА
Вернуть JSON с полем "is_lead" и "reason".
- true -> Автор ищет исполнителя (бот, сайт, парсер, скрипт).
- false -> Автор ищет работу, рекламирует услуги, задает вопросы или просто болтает.

### ПРАВИЛА (is_lead = true):
1. Намерение нанять: "нужен кодер", "кто напишет", "ищу разработчика", "требуется".
2. Конкретика: Понятно, что делать.
3. Оплата: Подразумевается контекстом ("пишите в лс", "срок", "бюджет").

### ПРИМЕРЫ:
User: "Всем ку, я python разраб, ищу заказы."
AI: {"is_lead": false, "reason": "Автор предлагает услуги (резюме)."}

User: "Нужен бот для автопостинга. Пишите в личку."
AI: {"is_lead": true, "reason": "Явный запрос исполнителя на разработку бота."}

User: "Кто может помочь с ошибкой в aiogram?"
AI: {"is_lead": false, "reason": "Технический вопрос, не заказ."}

User: "Требуется написать парсер."
AI: {"is_lead": true, "reason": "Четкая задача на разработку."}

### ФОРМАТ ОТВЕТА (JSON):
{
  "is_lead": boolean,
  "reason": "Кратко: почему это заказ или почему это мусор"
}
`.trim();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = (typeof req.body === 'object' && req.body !== null) ? req.body : {};
    const { text } = body as { text?: string };

    // Валидация: слишком короткие тексты сразу отсеиваем
    if (typeof text !== 'string' || !text.trim() || text.length < 5) {
       return res.status(200).json({
        ok: true,
        is_lead: false,
        reason: 'Text is too short',
      });
    }

    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: text },
    ];

    for (let modelIdx = 0; modelIdx < MODEL_FALLBACKS.length; modelIdx++) {
      const model = MODEL_FALLBACKS[modelIdx];
      
      for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
        try {
          const completion = await groq.chat.completions.create({
            model,
            messages,
            max_tokens: 200, 
            temperature: 0.1,
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
                throw new Error("No JSON found");
            }
          } catch (e) {
            console.warn(`[${model}] JSON parse failed:`, content);
            throw new Error("Invalid JSON format");
          }

          // Возвращаем только то, что просил: is_lead и reason
          return res.status(200).json({
            ok: true,
            model,
            is_lead: Boolean(parsed.is_lead),
            reason: String(parsed.reason ?? ''),
          });

        } catch (err: any) {
          const status = err.status ?? err.response?.status;
          if (status === 429 || err.code === 'rate_limit_exceeded') break; // Next model
          if (status >= 500 && attempt < RETRIES_PER_MODEL) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          break;
        }
      }
    }

    return res.status(503).json({
      ok: false,
      error: 'All models failed',
    });

  } catch (e: any) {
    console.error('FATAL_HANDLER_ERROR', e);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}
