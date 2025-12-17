import crypto from "crypto";
import fetch from "node-fetch";
import { v2 as cloudinary } from "cloudinary";
import OpenAI from "openai";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  const events = req.body.events;
  if (!events || events.length === 0) {
    return res.status(200).end();
  }

  const event = events[0];
  const replyToken = event.replyToken;

  // ===== テキスト =====
  if (event.message.type === "text") {
    await reply(replyToken, `受信しました 👍\n「${event.message.text}」`);
    return res.status(200).end();
  }

  // ===== 画像 =====
  if (event.message.type === "image") {
    await reply(replyToken, "📸 解析中です…少しお待ちください");

    try {
      // 1️⃣ LINEから画像取得（Bearer必須）
      const imgRes = await fetch(
        `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
        {
          headers: {
            Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
        }
      );
      const buffer = await imgRes.arrayBuffer();

      // 2️⃣ Cloudinaryへアップロード
      const uploadResult = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          {
            upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET,
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        ).end(Buffer.from(buffer));
      });

      // 3️⃣ OpenAI Vision
      const ai = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "この料理の名前とカロリーを推定してください" },
              { type: "input_image", image_url: uploadResult.secure_url },
            ],
          },
        ],
      });

      const result =
        ai.output_text ||
        "🍽 推定結果\n解析できませんでした";

      await reply(replyToken, `🍽 推定結果\n${result}`);
    } catch (e) {
      console.error(e);
      await reply(
        replyToken,
        "❌ 解析に失敗しました（画像が不明瞭な可能性があります）"
      );
    }
  }

  res.status(200).end();
}

async function reply(token, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken: token,
      messages: [{ type: "text", text }],
    }),
  });
}
