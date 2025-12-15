import https from "https";

export const config = {
  api: {
    bodyParser: true,
  },
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// LINEに返信
function replyToLine(replyToken, text) {
  const body = JSON.stringify({
    replyToken,
    messages: [{ type: "text", text }],
  });

  const options = {
    hostname: "api.line.me",
    path: "/v2/bot/message/reply",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Authorization": `Bearer ${LINE_TOKEN}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      res.on("data", () => {});
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// LINE画像取得
function getLineImage(messageId) {
  const options = {
    hostname: "api.line.me",
    path: `/v2/bot/message/${messageId}/content`,
    method: "GET",
    headers: {
      "Authorization": `Bearer ${LINE_TOKEN}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.toString("base64"));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// OpenAI Vision
async function analyzeFood(base64Image) {
  const body = JSON.stringify({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "この料理名とおおよそのカロリー(kcal)を教えてください。簡潔に。" },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${base64Image}`,
            },
          },
        ],
      },
    ],
  });

  const options = {
    hostname: "api.openai.com",
    path: "/v1/chat/completions",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        const json = JSON.parse(data);
        resolve(json.choices[0].message.content);
      });
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

    const event = req.body.events?.[0];
    if (!event) return res.status(200).json({});

    // 📸 画像メッセージ
    if (event.type === "message" && event.message.type === "image") {
      await replyToLine(event.replyToken, "解析中です…🍽️");

      const base64Image = await getLineImage(event.message.id);
      const result = await analyzeFood(base64Image);

      await replyToLine(
        event.replyToken,
        `🍴 推定結果\n${result}`
      );
    }

    return res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
