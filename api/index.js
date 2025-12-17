export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const event = req.body?.events?.[0];
  if (!event) return res.status(200).end();

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
      // 1️⃣ LINE画像取得
      const imgRes = await fetch(
        `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
        {
          headers: {
            Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
        }
      );

      const buffer = Buffer.from(await imgRes.arrayBuffer());

      // 2️⃣ Cloudinary（unsigned upload）
      const form = new FormData();
      form.append("file", new Blob([buffer]));
      form.append("upload_preset", process.env.CLOUDINARY_UPLOAD_PRESET);

      const cloudRes = await fetch(
        `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
        {
          method: "POST",
          body: form,
        }
      );

      const cloudData = await cloudRes.json();
      const imageUrl = cloudData.secure_url;

      // 3️⃣ OpenAI Vision（REST API直叩き）
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
                { type: "input_text", text: "料理名とカロリーを推定してください" },
                { type: "input_image", image_url: imageUrl },
              ],
            },
          ],
        }),
      });

      const aiData = await aiRes.json();
      const result =
        aiData.output?.[0]?.content?.[0]?.text ||
        "解析できませんでした";

      await reply(replyToken, `🍽 推定結果\n${result}`);
    } catch (e) {
      console.error(e);
      await reply(replyToken, "❌ 解析に失敗しました");
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
