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
      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          replyToken: event.replyToken,
          messages: [
            { type: "text", text: `あなたは「${event.message.text}」と送りました` },
          ],
        }),
      });
    }

    // 画像
    if (event.message?.type === "image") {
      // ① 画像取得
      const imageRes = await fetch(
        `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
        {
          headers: {
            Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
        }
      );

      // ② バイナリ → base64
      const buffer = await imageRes.arrayBuffer();
      const base64Image = Buffer.from(buffer).toString("base64");

      // ③ サイズ確認（ログ用）
      console.log("image base64 length:", base64Image.length);

      // ④ 返信
      await fetch("https://api.line.me/v2/bot/message/reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
        body: JSON.stringify({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: `📸 画像取得OK\nサイズ: ${Math.round(base64Image.length / 1024)}KB`,
            },
          ],
        }),
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ error: e.message });
  }
}
