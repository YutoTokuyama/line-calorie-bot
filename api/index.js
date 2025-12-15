export const config = {
  runtime: "nodejs",
};

export default async function handler(req, res) {
  try {
    const event = req.body?.events?.[0];
    if (!event) return res.status(200).send("OK");

    // ===== テキスト =====
    if (event.message?.type === "text") {
      await reply(event.replyToken, `受信しました 👍\n「${event.message.text}」`);
      return res.status(200).json({ ok: true });
    }

    // ===== 画像 =====
    if (event.message?.type === "image") {
      // ① 解析中を即返す
      await reply(event.replyToken, "📸 解析中です…少しお待ちください");

      // ② LINEから画像取得
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

      // ③ OpenAI Responses API（Vision対応）
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
                  text: "この食事の内容を日本語で簡潔に説明し、合計カロリー（kcal）を概算してください。",
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
      console.log("AI response:", JSON.stringify(aiJson));

      const result =
        aiJson.output_text ||
        "解析に失敗しました（画像が不明瞭な可能性があります）";

      // ④ pushで結果送信
      await pushMessage(
        event.source.userId,
        `🍽 推定結果\n\n${result}`
      );

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("ERROR:", e);
    return res.status(200).json({ error: e.message });
  }
}

// ===== 共通関数 =====
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

async function pushMessage(userId, text) {
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
