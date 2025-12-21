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

// Новый, более жёсткий системный промт
const SYSTEM_PROMPT = `
Ты — строгий фильтр лидов для фрилансера Python‑разработчика. Твоя цель — найти только ТЕ сообщения, где автор предлагает оплачиваемую работу исполнителю.

Считай лидом (is_lead = true) ТОЛЬКО те сообщения, где автор ЯВНО ищет исполнителя и предлагает оплату за разработку или исправление кода
(бот, парсер, скрипт, сайт, интеграция и т.п.), с формулировками вроде:
«нужен разработчик», «ищем программиста», «кто сделает бота», «кто напишет парсер»,
«ищу исполнителя», «нужно сделать задачу за оплату», «бюджет N», «оплачу», «готов заплатить», «зарплата/ставка/гонорар».

Во всех остальных случаях ставь is_lead = false:
- автор рекламирует свои услуги, студию, агентство или бота («я делаю сайты», «мы автоматизируем бизнес», «наш проект делает…»);
- автор пишет резюме или ищет работу для себя («я разработчик, ищу заказы/работу»);
- сообщение про репутацию, рейтинг, достижения, мотивацию, обучение;
- общие технические вопросы и обсуждения («как настроить Django», «что лучше, Django или FastAPI», «какую видеокарту взять»);
- системные и служебные сообщения, мемы, флуд, оффтоп;
- нет явной связки «ищу исполнителя + оплата/бюджет» в ЭТОМ сообщении.

Очень важные правила:
1. Анализируй только текст ЭТОГО сообщения, без треда и истории. Нельзя додумывать контекст.
2. Если нет чёткой формулировки, что нужен исполнитель, и нет упоминания денег/оплаты/бюджета — is_lead = false.
3. Самопрезентации, реклама услуг, описания своих проектов и студий ВСЕГДА is_lead = false, даже если там есть слова «клиенты», «проекты», «зарабатываем».

Формат ответа — строго JSON:

{
  "is_lead": boolean,
  "summary": "очень кратко, что за заказ или почему это не лид",
  "reason": "подробное объяснение решения, с цитатами ключевых фраз"
}

Если сомневаешься — ставь is_lead = false и объясняй, чего не хватает (нет задачи, нет оплаты, автор продаёт свои услуги, это просто комментарий и т.п.).
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
