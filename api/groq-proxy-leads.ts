import Groq from "groq-sdk";

export const config = {
  runtime: "edge",
};

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

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
✅ ЭТО ЛИД (is_lead = true):
- Четкая потребность: "нужен бот", "ищу разработчика", "кто напишет парсер".
- Готовность платить: "бюджет 50к", "сделаю заказ", "ищу исполнителя".
- Срочность + задача: "нужно срочно поправить скрипт".
- Неявные лиды: "кто может помочь с ботом (платно)?".

❌ ЭТО МУСОР (is_lead = false):
- Вопросы новичков: "как установить requests?", "почему ошибка 403?".
- Короткие вопросы без контекста: "Пайтон?", "Есть кто живой?", "Java?".
- Технические споры: "что лучше, Django или FastAPI?".
- Поиск работы автором: "ищу заказы", "я разработчик".
- Вакансии в офис/штат: "требуется Middle в офис", "ДМС, печеньки".
- Реклама курсов/каналов.

ПРИМЕРЫ REASON:
- "Отказ: это технический вопрос по настройке сервера, а не заказ."
- "Отказ: автор сам ищет работу (резюме)."
- "Одобрено: явный запрос на разработку бота с упоминанием бюджета."
- "Отказ: сообщение слишком короткое и не содержит задачи."
`;

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST requests allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const { text } = await req.json();

    if (!text) {
      return new Response(JSON.stringify({ error: "No text provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      model: "llama3-8b-8192",
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const result = JSON.parse(completion.choices[0]?.message?.content || "{}");
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Error processing request:", error);
    return new Response(JSON.stringify({ error: "Internal Server Error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
