import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// LINEに返信
async function reply(replyToken, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
}

// 画像からカロリー推定
async function analyzeFood(base64Image) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "この料理の内容を特定し、推定カロリーをkcalで日本語で簡潔に出してください。可能なら料理名も。",
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`,
            },
          },
        ],
      },
    ],
    max_tokens: 300,
  });

  return res.choices[0].message.content;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).send("OK");
    }

    const event = req.body?.events?.[0];
    if (!event) {
      return res.status(200).json({ ok: true });
    }

    // テキストはそのまま返す
    if (event.message?.type === "text") {
      await reply(
        event.replyToken,
        `受信しました 👍\n「${event.message.text}」`
      );
      return res.status(200).json({ ok: true });
    }

    // 画像
    if (event.message?.type === "image") {
      // ① 解析中
      await reply(event.replyToken, "📸 解析中です…少しお待ちください");

      // ② 画像取得
      const imageRes = await fetch(
        `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
        {
          headers: {
            Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
        }
      );

      const buffer = await imageRes.arrayBuffer();
      const base64Image = Buffer.from(buffer).toString("base64");

      // ③ OpenAI解析
      const result = await analyzeFood(base64Image);

      // ④ 結果返信
      await reply(
        event.replyToken,
        `🍴 推定結果\n\n${result}`
      );

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("ERROR:", e);
    try {
      const event = req.body?.events?.[0];
      if (event?.replyToken) {
        await reply(
          event.replyToken,
          "⚠️ エラーが発生しました。時間をおいて再度お試しください。"
        );
      }
    } catch (_) {}
    return res.status(200).json({ error: e.message });
  }
}
