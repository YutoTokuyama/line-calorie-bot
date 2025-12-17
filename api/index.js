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
      const judgeRes = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          input: `
次のテキストが料理名または食材名かどうかを判定してください。
料理・食材なら YES、それ以外は NO のみで答えてください。

テキスト: ${userText}
          `,
        }),
      });

      const judgeData = await judgeRes.json();
      const judge = extractText(judgeData)?.trim();

      if (judge === "YES") {
        const aiRes = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            input: `
以下の料理・食材について、必ず次の形式で出力してください。
Markdown記法は使わないでください。

🍽 推定結果（目安）

🔥 合計
カロリー：約 xxx kcal
PFC
・たんぱく質：xx g
・脂質：xx g
・炭水化物：xx g

――――――――――
① 料理名
カロリー：約 xxx kcal
PFC
・たんぱく質：xx g
・脂質：xx g
・炭水化物：xx g

② 料理名
カロリー：約 xxx kcal
PFC
・たんぱく質：xx g
・脂質：xx g
・炭水化物：xx g

（料理があるだけ続ける）

✅ ポイント
栄養バランスや食べ方について一言コメントしてください。

料理・食材名：
${userText}
            `,
          }),
        });

        const aiData = await aiRes.json();
        const text = extractText(aiData) || "解析できませんでした";

        await reply(replyToken, text);
      } else {
        await reply(
          replyToken,
          "料理や食材をテキストか写真で送ると目安カロリーとPFCを知ることができます 📸🍽"
        );
      }
    } catch (e) {
      console.error(e);
      await reply(replyToken, "❌ エラーが発生しました");
    }

    return res.status(200).end();
  }

  /* ===== 画像 ===== */
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
                {
                  type: "input_text",
                  text: `
写真に写っている料理・食材をすべて特定してください。
1品とは限らない前提で解析してください。

必ず次の形式で出力してください。
Markdown記法は禁止です。

🍽 推定結果（目安）

🔥 合計
カロリー：約 xxx kcal
PFC
・たんぱく質：xx g
・脂質：xx g
・炭水化物：xx g

――――――――――
① 料理名
カロリー：約 xxx kcal
PFC
・たんぱく質：xx g
・脂質：xx g
・炭水化物：xx g

② 料理名
カロリー：約 xxx kcal
PFC
・たんぱく質：xx g
・脂質：xx g
・炭水化物：xx g

（料理があるだけ続ける）

✅ ポイント
全体の栄養バランスについて一言コメント
                  `,
                },
                { type: "input_image", image_url: imageUrl },
              ],
            },
          ],
        }),
      });

      const aiData = await aiRes.json();
      const text = extractText(aiData) || "解析できませんでした";

      await push(userId, text);
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
