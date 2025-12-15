import https from "https";

export const config = {
  api: {
    bodyParser: true,
  },
};

function replyToLine(replyToken, text) {
  const body = JSON.stringify({
    replyToken,
    messages: [
      {
        type: "text",
        text,
      },
    ],
  });

  const options = {
    hostname: "api.line.me",
    path: "/v2/bot/message/reply",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      res.on("data", () => {});
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).send("OK");
    }

    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    const events = req.body.events;
    if (!events || events.length === 0) {
      return res.status(200).json({ status: "no events" });
    }

    const event = events[0];

    // 📸 画像メッセージ
    if (event.type === "message" && event.message.type === "image") {
      await replyToLine(event.replyToken, "写真を受信しました 📸");
      return res.status(200).json({ status: "image received" });
    }

    // ✍️ テキストメッセージ
    if (event.type === "message" && event.message.type === "text") {
      await replyToLine(
        event.replyToken,
        `受信しました 👍\n「${event.message.text}」`
      );
      return res.status(200).json({ status: "text received" });
    }

    return res.status(200).json({ status: "ignored" });

  } catch (err) {
    console.error("ERROR:", err);
    return res.status(500).json({ error: err.message });
  }
}
