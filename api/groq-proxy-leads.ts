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

// Модели Groq по приоритету (Llama 3.3 70b сейчас топ для таких задач)
const MODEL_FALLBACKS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'mixtral-8x7b-32768',
];

const RETRIES_PER_MODEL = 2;

// ОБНОВЛЕННЫЙ ПРОМТ (Few-Shot Strategy)
const SYSTEM_PROMPT = `
Ты — AI-ассистент для фильтрации коммерческих лидов в чатах IT-фрилансеров.
Твоя единственная цель: понять, является ли сообщение **ЗАКАЗОМ** на разработку (автор хочет нанять/заплатить).

### ТВОЯ ЗАДАЧА
Вернуть JSON с полем "is_lead":
- true -> Автор ищет исполнителя для конкретной задачи (бот, сайт, парсер, скрипт).
- false -> Автор ищет работу, просто общается, задает тех. вопросы или сообщение не содержит задачи.

### ПРАВИЛА ОПРЕДЕЛЕНИЯ (is_lead = true):
1. **Намерение нанять:** Фразы "нужен кодер", "кто напишет", "ищу разработчика", "требуется", "надо сделать".
2. **Конкретика:** Понятно, что делать (бот для тг, парсер авито, фикс багов, верстка).
3. **Контекст оплаты:** Слово "бюджет" НЕ ОБЯЗАТЕЛЬНО, если очевидно, что это заказ. Фразы "пишите в лс", "срочно", "тз скину" при наличии задачи считаются признаком заказа.

### ЖЕСТКИЕ ФИЛЬТРЫ (is_lead = false):
- **Поиск работы:** "Ищу заказы", "Могу сделать", "Возьму задачу", "Я разработчик".
- **Реклама:** "Делаем ботов под ключ", "Наша студия".
- **Вопросы новичков:** "Как запустить бота?", "Почему ошибка в коде?", "Какую библиотеку юзать?".
- **Мусор:** Приветствия, одиночные символы ("?", "."), обсуждение цены без задачи ("Дорого", "500р").

### ПРИМЕРЫ (Обучение):
User: "Всем ку, я python разраб, ищу заказы."
AI: {"is_lead": false, "summary": "Резюме", "reason": "Автор предлагает услуги, а не ищет их."}

User: "Нужен бот для автопостинга. Пишите в личку."
AI: {"is_lead": true, "summary": "Заказ на бота", "reason": "Явный запрос исполнителя ('Нужен бот')."}

User: "Кто может помочь с ошибкой в aiogram? Не работает поллинг."
AI: {"is_lead": false, "summary": "Технический вопрос", "reason": "Автор просит помощи, а не нанимает."}

User: "Требуется написать парсер. Бюджет обсуждаем."
AI: {"is_lead": true, "summary": "Заказ парсера", "reason": "Есть задача и готовность обсуждать бюджет."}

User: "?"
AI: {"is_lead": false, "summary": "Мусор", "reason": "Нет текста задачи."}

### ФОРМАТ ОТВЕТА
Только чистый JSON объект:
{
  "is_lead": boolean,
  "summary": "string (кратко суть)",
  "reason": "string (почему принято такое решение)"
}
`.trim();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = (typeof req.body === 'object' && req.body !== null) ? req.body : {};
    const { text } = body as { text?: string };

    // Базовая валидация входящего текста
    if (typeof text !== 'string' || !text.trim() || text.length < 5) {
       // Если текст короче 5 символов (например "?"), сразу отбиваем без LLM для экономии
       return res.status(200).json({
        ok: true,
        is_lead: false,
        summary: 'Too short',
        reason: 'Text is too short to be a valid lead',
      });
    }

    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: text },
    ];

    for (let modelIdx = 0; modelIdx < MODEL_FALLBACKS.length; modelIdx++) {
      const model = MODEL_FALLBACKS[modelIdx];
      let lastError: any = null;

      // console.log(`[MODEL_TRY] ${modelIdx + 1}/${MODEL_FALLBACKS.length}: ${model}`);

      for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
        try {
          const completion = await groq.chat.completions.create({
            model,
            messages,
            max_tokens: 256, // Для JSON ответа много токенов не нужно
            temperature: 0.1, // Минимальная температура для строгости
            response_format: { type: 'json_object' } // Форсируем JSON режим (поддерживается новыми моделями)
          });

          const content = completion.choices[0]?.message?.content ?? '';
          
          let parsed: any = null;
          try {
             // Пытаемся распарсить JSON, даже если модель добавила мусор вокруг
            const jsonStart = content.indexOf('{');
            const jsonEnd = content.lastIndexOf('}');
            if (jsonStart !== -1 && jsonEnd !== -1) {
                const jsonSlice = content.slice(jsonStart, jsonEnd + 1);
                parsed = JSON.parse(jsonSlice);
            } else {
                throw new Error("No JSON found");
            }
          } catch (e) {
            console.warn(`[${model}] JSON parse failed:`, content);
            // Если модель выдала не JSON, пробуем следующую или считаем ошибкой
            throw new Error("Invalid JSON format");
          }

          return res.status(200).json({
            ok: true,
            model,
            is_lead: Boolean(parsed.is_lead),
            summary: String(parsed.summary ?? ''),
            reason: String(parsed.reason ?? ''),
          });

        } catch (err: any) {
          lastError = err;
          const status = err.status ?? err.response?.status;
          
          // Логика обработки 429 (Rate Limit)
          if (status === 429 || err.code === 'rate_limit_exceeded') {
            console.warn(`[${model}] RATE_LIMIT, switching model...`);
            break; // Выходим из цикла ретраев, идем к следующей модели
          }

          // Если 5xx ошибка Groq — пробуем еще раз (attempt)
          if (status >= 500 && status < 600 && attempt < RETRIES_PER_MODEL) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          
          // Другие ошибки — ломаем цикл ретраев
          break;
        }
      }
    }

    return res.status(503).json({
      ok: false,
      error: 'All models failed or rejected format',
    });

  } catch (e: any) {
    console.error('FATAL_HANDLER_ERROR', e);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}
