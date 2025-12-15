export const config = {
  runtime: "nodejs",
};

export default async function handler(req, res) {
  try {
    const event = req.body?.events?.[0];
    if (!event) return res.status(200).send("OK");

    let replyText = "❓ 未対応のメッセージです";

    if (event.type === "message") {
      if (event.message.type === "text") {
        replyText = `✉️ テキスト受信：${event.message.text}`;
      }

      if (event.message.type === "image") {
        replyText = "📸 画像を受信しました";
      }
    }

    await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: replyText }],
      }),
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ error: e.message });
  }
}
