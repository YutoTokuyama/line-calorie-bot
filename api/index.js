import fetch from "node-fetch";

const LINE_REPLY_API = "https://api.line.me/v2/bot/message/reply";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const event = req.body.events?.[0];
    if (!event) return res.status(200).json({ ok: true });

    const replyToken = event.replyToken;
    const message = event.message;

    // =========================
    // テキストメッセージ
    // =========================
    if (message.type === "text") {
      await reply(replyToken, `受信しました 👍\n「${message.text}」`);
      return res.status(200).json({ ok: true });
    }

    // =========================
    // 画像メッセージ
    // =========================
    if (message.type === "image") {
      await reply(replyToken, "📸 解析中です…少しお待ちください");

      // 画像取得
      const imageRes = await fetch(
        `https://api-data.line.me/v2/bot/message/${message.id}/content`,
        {
          headers: {
            Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
        }
      );

      const imageBuffer = await imageRes.arrayBuffer();
      const base64Image = Buffer.from(imageBuffer).toString("base64");

      // OpenAI API
      const aiRes = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "この食事の内容とカロリーを日本語で推定してください",
                },
                {
                  type: "input_image",
                  image_base64: base64Image,
                },
              ],
            },
          ],
        }),
      });

      const aiJson = await aiRes.json();
      console.log("AI FULL RESPONSE:", JSON.stringify(aiJson, null, 2));

      const result =
        aiJson.output?.[0]?.content?.[0]?.text ||
        "解析に失敗しました（AIの解析結果が取得できませんでした）";

      await reply(replyToken, `🍽 推定結果\n\n${result}`);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).send("Internal Server Error");
  }
}

// =========================
// LINE返信関数
// =========================
async function reply(replyToken, text) {
  await fetch(LINE_REPLY_API, {
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
