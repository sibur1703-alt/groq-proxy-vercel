// api/groq-proxy-leads.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import Groq from 'groq-sdk';

export const config = {
  runtime: 'edge',
};

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

// Модели по приоритету: от самой умной к более дешёвым/безлимитным
const MODEL_FALLBACKS = [
  'llama-3.3-70b-versatile', // 100K токенов/сутки [web:121][web:128]
  'llama-3.1-8b-instant',    // 500K токенов/сутки [web:121]
  'allam-2-7b',              // 500K токенов/сутки [web:121]
  'groq/compound-mini',      // No limit (последний шанс) [web:121][web:130]
];

const RETRIES_PER_MODEL = 2;

// Твой системный промт (можешь подправить под себя)
const SYSTEM_PROMPT = `
Ты — AI-фильтр для фрилансера (Python‑разработчика). Твоя цель — найти ДЕНЬГИ.
Анализируй сообщения из чатов и ищи ТОЛЬКО коммерческие заказы.

Твоя задача — классифицировать сообщение и вернуть JSON:

{
  "is_lead": boolean,
  "summary": "краткая суть заказа (или причина отказа)",
  "reason": "анализ: почему это лид или спам? (будь конкретен!)"
}
`.trim();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ВАЖНО: безопасно читаем тело, чтобы не было
    // "Cannot destructure property 'text' of 'req.body' as it is undefined"
    const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
    const { text } = body as { text?: string };

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Field "text" is required' });
    }

    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: text },
    ];

    // Перебор моделей по приоритету
    for (const model of MODEL_FALLBACKS) {
      let lastError: any = null;

      for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
        try {
          const completion = await groq.chat.completions.create({
            model,
            messages,
            max_tokens: 512,
            temperature: 0.2,
          }); // [web:125][web:132]

          const content = completion.choices[0]?.message?.content ?? '';

          return res.status(200).json({
            ok: true,
            model,
            content,
          });
        } catch (err: any) {
          lastError = err;

          const status = err.status ?? err.response?.status;
          const code =
            err.code ??
            err.response?.data?.error?.code ??
            err.response?.data?.error?.type;

          // 429 — выбит лимит модели, сразу идём к следующей
          if (status === 429 || code === 'rate_limit_exceeded') {
            console.warn(`Rate limit on model ${model}, switching fallback`, {
              status,
              code,
            });
            break;
          }

          // 5xx — пробуем ретрай на той же модели
          if (status >= 500 && status < 600 && attempt < RETRIES_PER_MODEL) {
            console.warn(
              `Server error on ${model}, retry ${attempt + 1}`,
              err.message,
            );
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }

          // Остальные ошибки — считаем фатальными для этой модели
          console.error(`Error on model ${model}`, err);
          break;
        }
      }

      console.warn(`Model ${model} failed, trying next fallback`);
    }

    // Если ни одна модель не отдала ответ
    return res
      .status(503)
      .json({ ok: false, error: 'All Groq models failed or hit rate limits' });
  } catch (e: any) {
    console.error('Fatal error in groq-proxy-leads handler', e);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}
