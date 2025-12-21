import Groq from 'groq-sdk';

// Заглушки типов, чтобы не тянуть @vercel/node
type VercelRequest = any;
type VercelResponse = any;

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

const SYSTEM_PROMPT = `
Ты — AI-фильтр для фрилансера (Python-разработчика). Твоя цель — найти ДЕНЬГИ.
Анализируй сообщения из чатов и ищи ТОЛЬКО коммерческие заказы.

Твоя задача — классифицировать сообщение и вернуть JSON:
{
  "is_lead": boolean,
  "summary": "краткая суть заказа (или причина отказа)",
  "reason": "анализ: почему это лид или спам? (будь конкретен!)"
}

ПРАВИЛА ОТБОРА:
 ЭТО ЛИД (is_lead = true):
- Четкая потребность: "нужен бот", "ищу разработчика", "кто напишет парсер".
- Готовность платить: "бюджет 50к", "сделаю заказ", "ищу исполнителя".
- Срочность + задача: "нужно срочно поправить скрипт".

 ЭТО МУСОР (is_lead = false):
- Вопросы новичков: "как установить requests?", "почему ошибка 403?".
- Короткие вопросы без контекста: "Пайтон?", "Есть кто живой?".
- Технические споры: "что лучше, Django или FastAPI?".
- Поиск работы автором: "ищу заказы", "я разработчик".
- Вакансии в офис/штат: "требуется Middle в офис", "ДМС, печеньки".
- Реклама курсов/каналов.

ПРИМЕРЫ REASON:
- "Отказ: это технический вопрос по настройке сервера, а не заказ."
- "Отказ: автор сам ищет работу (резюме)."
- "Одобрено: явный запрос на разработку бота с упоминанием бюджета."
- "Отказ: сообщение слишком короткое и не содержит задачи."
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

          // Пытаемся вытащить JSON из ответа
          let parsed: any = null;
          try {
            const jsonStart = content.indexOf('{');
            const jsonEnd = content.lastIndexOf('}');
            const jsonSlice =
              jsonStart >= 0 && jsonEnd > jsonStart
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
