// api/groq-proxy-leads.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import Groq from 'groq-sdk';

export const config = {
  runtime: 'nodejs',
};

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

// Модели по приоритету: от самой умной к более дешёвым/безлимитным
const MODEL_FALLBACKS = [
  'llama-3.3-70b-versatile', // 100K токенов/сутки
  'llama-3.1-8b-instant',    // 500K токенов/сутки
  'allam-2-7b',              // 500K токенов/сутки
  'groq/compound-mini',      // No limit (последний шанс)
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

    // ВАЖНО: безопасно читаем тело
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
    for (let modelIdx = 0; modelIdx < MODEL_FALLBACKS.length; modelIdx++) {
      const model = MODEL_FALLBACKS[modelIdx];
      let lastError: any = null;

      console.log(`[MODEL_TRY] Attempting model ${modelIdx + 1}/${MODEL_FALLBACKS.length}: ${model}`);

      for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
        try {
          console.log(`[${model}] Attempt ${attempt + 1}/${RETRIES_PER_MODEL + 1}`);

          const completion = await groq.chat.completions.create({
            model,
            messages,
            max_tokens: 512,
            temperature: 0.2,
          });

          const content = completion.choices[0]?.message?.content ?? '';

          console.log(`[${model}] SUCCESS - returning response`);

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
          const message = err.message ?? 'Unknown error';

          // 429 — rate limit, выбит лимит модели
          if (status === 429 || code === 'rate_limit_exceeded') {
            console.warn(`[${model}] RATE_LIMIT (429) - switching to next model`, {
              status,
              code,
              message,
            });
            // Выходим из цикла ретраев и переходим к следующей модели
            break;
          }

          // 5xx — server error, пробуем ретрай на той же модели
          if (status >= 500 && status < 600 && attempt < RETRIES_PER_MODEL) {
            console.warn(
              `[${model}] SERVER_ERROR (${status}) - retry ${attempt + 1}/${RETRIES_PER_MODEL}`,
              message,
            );
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            continue; // Идём на следующую итерацию внутреннего цикла
          }

          // Остальные ошибки (4xx, timeout и т.д.) — считаем фатальными
          console.error(`[${model}] FATAL_ERROR (${status}) - moving to next model`, {
            status,
            code,
            message,
          });
          break; // Выходим и переходим к следующей модели
        }
      }

      // После выхода из цикла ретраев — если до сих пор нет ответа, логируем и идём на следующую
      console.warn(
        `[${model}] All attempts exhausted or rate limited, trying next fallback...`,
      );
    }

    // Если ни одна модель не отдала ответ после полного перебора
    console.error('ALL_MODELS_FAILED - All Groq models exhausted');
    return res.status(503).json({
      ok: false,
      error: 'All Groq models failed or hit rate limits',
    });
  } catch (e: any) {
    console.error('FATAL_HANDLER_ERROR in groq-proxy-leads handler', e);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}
