export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const event = req.body?.events?.[0];
  if (!event) return res.status(200).end();

  const replyToken = event.replyToken;
  const userId = event.source?.userId;

  /* ===== テキスト ===== */
  if (event.message.type === "text") {
    const userText = event.message.text;

    try {
      const aiRes = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: `
次のテキストが「料理名または食材名」かどうかを判定してください。

・料理/食材なら → YES
・それ以外なら → NO

テキスト: ${userText}
          `,
        }),
      });

      const aiData = await aiRes.json();
      const judge = extractText(aiData)?.trim();

      if (judge === "YES") {
        // カロリー推定
        const kcalRes = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            input: `${userText} の目安カロリーとPFC（たんぱく質g・脂質g・炭水化物g）を日本語で分かりやすく教えてください`,
          }),
        });

        const kcalData = await kcalRes.json();
        const kcalText = extractText(kcalData) || "推定できませんでした";

        await reply(replyToken, `🍽 推定結果\n${kcalText}`);
      } else {
        await reply(
          replyToken,
          "料理や食材をテキストか写真で送ると目安カロリーを知ることができます 📸🍽"
        );
      }
    } catch (e) {
      console.error(e);
      await reply(replyToken, "❌ エラーが発生しました");
    }

    return res.status(200).end();
  }

  /* ===== 画像（今まで通り） ===== */
  if (event.message.type === "image") {
    await reply(replyToken, "📸 解析中です…少しお待ちください");

    try {
      const imgRes = await fetch(
        `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
        {
          headers: {
            Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
        }
      );
      const buffer = Buffer.from(await imgRes.arrayBuffer());

      const form = new FormData();
      form.append("file", new Blob([buffer]));
      form.append("upload_preset", process.env.CLOUDINARY_UPLOAD_PRESET);

      const cloudRes = await fetch(
        `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
        { method: "POST", body: form }
      );

      const cloudData = await cloudRes.json();
      const imageUrl = cloudData.secure_url;

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
                { type: "input_text", text: "料理名と目安カロリーとPFC（たんぱく質g・脂質g・炭水化物g）を日本語で分かりやすく教えてください" },
                { type: "input_image", image_url: imageUrl },
              ],
            },
          ],
        }),
      });

      const aiData = await aiRes.json();
      const text = extractText(aiData) || "解析できませんでした";

      await push(userId, `🍽 推定結果\n${text}`);
    } catch (e) {
      console.error(e);
      await push(userId, "❌ 解析に失敗しました");
    }
  }

  res.status(200).end();
}

/* ===== reply ===== */
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

/* ===== push ===== */
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

/* ===== OpenAI text抽出 ===== */
function extractText(aiData) {
  try {
    for (const item of aiData.output || []) {
      for (const c of item.content || []) {
        if (c.type === "output_text" && c.text) {
          return c.text;
        }
      }
    }
  } catch {}
  return null;
}
