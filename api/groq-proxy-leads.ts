// api/groq-proxy-leads.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import Groq from 'groq-sdk';

export const config = {
  runtime: 'nodejs',
};

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY!,
});

// Модели по приоритету
const MODEL_FALLBACKS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'allam-2-7b',
  'groq/compound-mini',
];

const RETRIES_PER_MODEL = 2;

// Системный промпт
const SYSTEM_PROMPT = `
Ты — AI-фильтр для фрилансера (Python‑разработчика). Твоя цель — найти ДЕНЬГИ.
Анализируй сообщения из чатов и ищи ТОЛЬКО коммерческие заказы.

Тебе дают текст сообщения. Ты ДОЛЖЕН вернуть JSON строго в формате:

{
  "is_lead": boolean,
  "summary": "краткая суть заказа (или причина отказа)",
  "reason": "анализ: почему это лид или спам? (будь конкретен!)"
}

Требования:
- is_lead = true только если это потенциально оплачиваемый заказ/вакансия/лид.
- Если это флуд, оффтоп, обсуждение технологий, новости и т.п. — is_lead = false.
- summary пиши очень кратко, 1–2 предложения.
- reason пиши по делу, указывай ключевые фразы из текста.
`.trim();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = (typeof req.body === 'object' && req.body !== null) ? req.body : {};
    const { text } = body as { text?: string };

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Field "text" is required' });
    }

    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: text },
    ];

    for (let modelIdx = 0; modelIdx < MODEL_FALLBACKS.length; modelIdx++) {
      const model = MODEL_FALLBACKS[modelIdx];
      let lastError: any = null;

      console.log(`[MODEL_TRY] ${modelIdx + 1}/${MODEL_FALLBACKS.length}: ${model}`);

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
          console.log(`[${model}] SUCCESS`);

          // Пытаемся распарсить JSON из content
          let parsed: any = null;
          try {
            const jsonStart = content.indexOf('{');
            const jsonEnd = content.lastIndexOf('}');
            const jsonSlice = jsonStart >= 0 && jsonEnd > jsonStart
              ? content.slice(jsonStart, jsonEnd + 1)
              : content;
            parsed = JSON.parse(jsonSlice);
          } catch (e) {
            console.warn(`[${model}] JSON parse failed, raw content returned`);
            return res.status(200).json({
              ok: true,
              model,
              raw: content,
              is_lead: false,
              summary: 'LLM response not in JSON format',
              reason: 'Failed to parse JSON from model response',
            });
          }

          const is_lead = Boolean(parsed.is_lead);
          const summary = String(parsed.summary ?? '');
          const reason = String(parsed.reason ?? '');

          return res.status(200).json({
            ok: true,
            model,
            is_lead,
            summary,
            reason,
          });
        } catch (err: any) {
          lastError = err;
          const status = err.status ?? err.response?.status;
          const code =
            err.code ??
            err.response?.data?.error?.code ??
            err.response?.data?.error?.type;
          const message = err.message ?? 'Unknown error';

          if (status === 429 || code === 'rate_limit_exceeded') {
            console.warn(`[${model}] RATE_LIMIT 429, switching model`, { status, code, message });
            break;
          }

          if (status >= 500 && status < 600 && attempt < RETRIES_PER_MODEL) {
            console.warn(
              `[${model}] SERVER_ERROR ${status}, retry ${attempt + 1}/${RETRIES_PER_MODEL}`,
              message,
            );
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
            continue;
          }

          console.error(`[${model}] FATAL_ERROR`, { status, code, message });
          break;
        }
      }

      console.warn(`[${model}] exhausted, trying next model...`);
      if (modelIdx === MODEL_FALLBACKS.length - 1 && lastError) {
        console.error('ALL_MODELS_FAILED', lastError);
      }
    }

    return res.status(503).json({
      ok: false,
      error: 'All Groq models failed or hit rate limits',
    });
  } catch (e: any) {
    console.error('FATAL_HANDLER_ERROR', e);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}
