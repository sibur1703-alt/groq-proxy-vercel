import Groq from 'groq-sdk';

// Типы для Vercel (чтобы TypeScript не ругался)
type VercelRequest = any;
type VercelResponse = any;

export const config = {
  runtime: 'nodejs',
};

// 1. ИНИЦИАЛИЗАЦИЯ КЛИЕНТОВ (РОТАЦИЯ КЛЮЧЕЙ)
// Берем ключи из переменных окружения. Если ключа нет — он просто игнорируется.
const groqKeys = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
].filter((k): k is string => !!k && k.length > 0);

// Создаем пул клиентов Groq
const groqClients = groqKeys.map((apiKey) => new Groq({ apiKey }));

if (groqClients.length === 0) {
  console.error("NO GROQ API KEYS FOUND! CHECK .ENV");
}

// 2. СПИСОК МОДЕЛЕЙ (ОТ УМНЫХ К БЫСТРЫМ)
const MODEL_FALLBACKS = [
  'llama-3.3-70b-versatile', // Топ-1: Умная, понимает контекст (Лимит: ~100k токенов)
  'qwen/qwen-2.5-32b',       // Топ-2: Отличная альтернатива, строгая (Лимит: ~500k токенов)
  'llama-3.1-8b-instant',    // Топ-3: Резерв, очень быстрая (Лимит: ~500k токенов)
];

const RETRIES_PER_MODEL = 2; // Сколько раз долбить одну модель, если она упала (500/503)

// 3. СТРОГИЙ СИСТЕМНЫЙ ПРОМТ (FEW-SHOT)
const SYSTEM_PROMPT = `
Твоя роль: Жесткий фильтр спама и флуда для IT-чатов.
Твоя задача: Вернуть JSON {"is_lead": boolean, "reason": string}.

СТАВЬ "is_lead": true ТОЛЬКО ЕСЛИ:
1. Автор ЯВНО ищет исполнителя ("ищу кодера", "нужен бот", "кто сделает").
2. Автор ГОТОВ ПЛАТИТЬ (это коммерческий заказ, а не просьба помочь бесплатно).

СТАВЬ "is_lead": false (ЭТО ВАЖНО!):
- Если это просто вопрос ("как сделать?", "почему ошибка?").
- Если это реклама СВОИХ услуг ("сделаю ботов", "пишем сайты").
- Если это болтовня, ответы, приветствия ("спасибо", "актуально?", "в лс").
- Если текст короче 3 слов и без контекста ("цена", "еще").

ПРИМЕРЫ:
User: "Еще..." -> false (Мусор)
User: "Чем на русском..." -> false (Мусор)
User: "Нужен парсер, бюджет 5к" -> true (Заказ)
User: "Я пишу ботов, кому надо?" -> false (Реклама услуг, не заказчик)
User: "Помогите с ошибкой в питоне" -> false (Технический вопрос)
`.trim();

// 4. БЫСТРЫЙ ФИЛЬТР СТОП-СЛОВ (БЕЗ AI)
// Если сообщение состоит только из этих слов (или очень короткое с ними) — сразу в мусор.
const INSTANT_BLOCK_REGEX = /^(привет|ку|цена\??|актуально\??|спс|спасибо|помогите|как|почему|здравствуйте)$/i;

// --- ОСНОВНОЙ ХЕНДЛЕР ---
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Разрешаем только POST
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = (typeof req.body === 'object' && req.body !== null) ? req.body : {};
    const { text } = body as { text?: string };

    // --- ЭТАП 1: ПРЕДВАРИТЕЛЬНАЯ ПРОВЕРКА (БЕЗ ТРАТЫ ТОКЕНОВ) ---
    if (typeof text !== 'string' || !text.trim()) {
       return res.status(200).json({ ok: true, is_lead: false, reason: 'Empty text' });
    }

    const cleanText = text.trim();

    // Фильтр длины: < 15 символов — считаем мусором (фразы "Нужен бот" обычно длиннее)
    if (cleanText.length < 15) {
      return res.status(200).json({
        ok: true,
        is_lead: false,
        reason: 'Text too short (<15 chars), likely spam/chat',
      });
    }

    // Фильтр стоп-слов (для коротких фраз до 30 символов)
    if (cleanText.length < 30 && INSTANT_BLOCK_REGEX.test(cleanText.split(' ')[0])) {
         return res.status(200).json({
            ok: true,
            is_lead: false,
            reason: 'Stop-word filter triggered',
        });
    }

    // --- ЭТАП 2: ЗАПРОС К НЕЙРОСЕТЯМ (С РОТАЦИЕЙ) ---
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: cleanText },
    ];

    let lastError = null;

    // Перебираем модели по очереди
    for (const model of MODEL_FALLBACKS) {
      // Выбираем случайный ключ API для балансировки (Load Balancing)
      const randomClientIdx = Math.floor(Math.random() * groqClients.length);
      const groq = groqClients[randomClientIdx]; 
      
      // Пробуем несколько раз одну модель (на случай сетевого сбоя)
      for (let attempt = 0; attempt <= RETRIES_PER_MODEL; attempt++) {
        try {
          const completion = await groq.chat.completions.create({
            model: model,
            messages,
            max_tokens: 100, // Нам нужен только JSON, 100 токенов за глаза
            temperature: 0,   // Строгий детерминизм (без креатива)
            response_format: { type: 'json_object' } // Гарантируем JSON на выходе
          });

          const content = completion.choices[0]?.message?.content ?? '';
          
          // Парсим ответ
          const parsed = JSON.parse(content);

          // УСПЕХ! Возвращаем результат
          return res.status(200).json({
            ok: true,
            model: model, // Полезно знать, какая модель сработала
            is_lead: Boolean(parsed.is_lead),
            reason: String(parsed.reason || 'No reason'),
          });

        } catch (err: any) {
          lastError = err;
          const status = err.status ?? err.response?.status;
          
          console.warn(`[${model}] Attempt ${attempt} failed: ${err.message}`);

          // Если ошибка 429 (Rate Limit) — СРАЗУ меняем модель, не делаем retries
          if (status === 429 || err.code === 'rate_limit_exceeded') {
            break; 
          }
          
          // Если 500/503 (Сервер упал) — ждем и пробуем еще раз
          if (status >= 500 && attempt < RETRIES_PER_MODEL) {
            await new Promise((r) => setTimeout(r, 800)); // Пауза 0.8 сек
            continue;
          }
          
          // Другие ошибки — меняем модель
          break;
        }
      }
    }

    // --- ЭТАП 3: ЕСЛИ ВСЕ УМЕРЛО ---
    console.error('ALL_MODELS_FAILED', lastError);
    return res.status(503).json({
      ok: false,
      error: 'All AI models failed',
      details: lastError?.message,
    });

  } catch (e: any) {
    console.error('FATAL_HANDLER_ERROR', e);
    return res.status(500).json({ ok: false, error: 'Internal Server Error' });
  }
}
