import fetch from "node-fetch";
import { v2 as cloudinary } from "cloudinary";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  const event = req.body.events?.[0];
  if (!event) return res.status(200).send("No event");

  const replyToken = event.replyToken;
  const message = event.message;

  const reply = async (text) => {
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
  };

  // --- テキストメッセージ ---
  if (message.type === "text") {
    const userText = message.text;

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
            content: `
以下のテキストが「食材・料理名」の場合は、
1. 料理名
2. 推定カロリー（kcal）
3. PFC（たんぱく質g・脂質g・炭水化物g）

を日本語で分かりやすく出力してください。

食材や料理と関係ない内容の場合は、
「料理や食材をテキストか写真で送ると、目安カロリーとPFCを知ることができます」
とだけ返してください。

テキスト：
「${userText}」
`,
          },
        ],
      }),
    });

    const data = await aiRes.json();
    const text =
      data.output?.[0]?.content?.[0]?.text ||
      "解析できませんでした";

    await reply(text);
    return res.status(200).end();
  }

  // --- 画像メッセージ ---
  if (message.type === "image") {
    await reply("📸 解析中です…少しお待ちください");

    // 画像取得
    const imageRes = await fetch(
      `https://api-data.line.me/v2/bot/message/${message.id}/content`,
      {
        headers: {
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
      }
    );

    const buffer = await imageRes.buffer();

    // Cloudinaryへアップロード
    const uploadRes = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(buffer);
    });

    // AI解析
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
              { type: "input_text", text: "この料理のカロリーとPFC（たんぱく質・脂質・炭水化物）を推定して、日本語で分かりやすく出力してください。" },
              { type: "input_image", image_url: uploadRes.secure_url },
            ],
          },
        ],
      }),
    });

    const data = await aiRes.json();
    const text =
      data.output?.[0]?.content?.[0]?.text ||
      "解析できませんでした";

    await reply(text);
    return res.status(200).end();
  }

  return res.status(200).end();
}
