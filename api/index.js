import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// reply（1回だけ）
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

// push（何回でもOK）
async function push(userId, text) {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: "text", text }],
    }),
  });
}

// 画像解析
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
              "この料理の内容と推定カロリーを日本語で簡潔に教えてください。",
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

    // テキスト
    if (event.message?.type === "text") {
      await reply(
        event.replyToken,
        `受信しました 👍\n「${event.message.text}」`
      );
      return res.status(200).json({ ok: true });
    }

    // 画像
    if (event.message?.type === "image") {
      // ① 先に reply（1回だけ）
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

      // ④ push で結果送信
      await push(
        event.source.userId,
        `🍴 推定結果\n\n${result}`
      );

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("ERROR:", e);
    return res.status(200).json({ error: e.message });
  }
}
