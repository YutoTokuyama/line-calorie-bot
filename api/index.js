export const config = {
  api: {
    bodyParser: true,
  },
};

const LINE_REPLY_URL = "https://api.line.me/v2/bot/message/reply";

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).send("OK");
    }

    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    console.log("BODY:", req.body);

    const events = req.body.events;
    if (!events || events.length === 0) {
      return res.status(200).json({ status: "no events" });
    }

    const event = events[0];

    if (event.type !== "message" || event.message.type !== "text") {
      return res.status(200).json({ status: "ignored" });
    }

    const replyToken = event.replyToken;
    const userText = event.message.text;

    await fetch(LINE_REPLY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: "text",
            text: `受信しました 👍\n「${userText}」`,
          },
        ],
      }),
    });

    return res.status(200).json({ status: "replied" });
  } catch (err) {
    console.error("ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
}
