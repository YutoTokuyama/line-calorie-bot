import fetch from "node-fetch";
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// LINEに返信する関数
async function replyToLine(replyToken, text) {
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
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "この料理の内容とカロリーを日本語で簡潔に推定してください。",
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

  return response.choices[0].message.content;
}

export default async function handler(req, res) {
  try {
    // Webhook検証用
    if (req.method === "GET") {
      return res.status(200).send("OK");
    }

    const event = req.body.events?.[0];
    if (!event) {
      return res.status(200).json({ message: "No event" });
    }

    // テキストメッセージ
    if (event.type === "message" && event.message.type === "text") {
      await replyToLine(
        event.replyToken,
        `受信しました 👍\n「${event.message.text}」`
      );
      return res.status(200).json({ status: "ok" });
    }

    // 画像メッセージ
    if (event.type === "message" && event.message.type === "image") {
      await replyToLine(event.replyToken, "📸 解析中です…少しお待ちください");

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

      const result = await analyzeFood(base64Image);

      await replyToLine(
        event.replyToken,
        `🍴 推定結果\n\n${result}`
      );

      return res.status(200).json({ status: "ok" });
    }

    return res.status(200).json({ status: "ignored" });
  } catch (err) {
    console.error("ERROR:", err);

    try {
      const event = req.body.events?.[0];
      if (event?.replyToken) {
        await replyToLine(
          event.replyToken,
          "⚠️ 解析中にエラーが発生しました。時間をおいて再度お試しください。"
        );
      }
    } catch (_) {}

    return res.status(200).json({ error: err.message });
  }
}
