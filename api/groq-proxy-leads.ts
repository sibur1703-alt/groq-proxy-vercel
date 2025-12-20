// api/groq-proxy-leads.ts
import type { VercelRequest, VercelResponse } from '@vercel/node'
import Groq from 'groq-sdk'

const client = new Groq({ apiKey: process.env.GROQ_API_KEY })

const SYSTEM_PROMPT = `
Ты - эксперт по поиску лидов (lead generation). Твоя задача - анализировать сообщения в чатах.
Ищи сообщения, где автор явно ищет исполнителя, сотрудника или хочет заказать услугу.

Критерии ВАЖНОГО сообщения (Lead):
1. Автор пишет "нужен программист", "ищу дизайнера", "куплю рекламу", "кто сделает лендинг" и т.п.
2. Это НЕ реклама своих услуг этим же автором.
3. Это НЕ вакансия от HR, а прямой заказчик или человек, который хочет себе кого-то.

Верни ТОЛЬКО JSON вида:
{
  "is_lead": true/false,
  "summary": "кратко суть запроса",
  "reason": "почему ты так решил"
}
`

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY not set' })
    }

    const { text } = req.body as { text?: string }
    if (!text) {
      return res.status(400).json({ error: 'text is required' })
    }

    const completion = await client.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    })

    const raw = completion.choices[0]?.message?.content || '{}'
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = { is_lead: false, summary: 'parse_error', reason: raw.slice(0, 2000) }
    }

    return res.status(200).json(parsed)
  } catch (e: any) {
    console.error(e)
    return res.status(500).json({ error: String(e?.message || e) })
  }
}
