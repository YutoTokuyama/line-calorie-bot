export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const event = req.body?.events?.[0];
  if (!event) return res.status(200).end();

  const replyToken = event.replyToken;
  const userId = event.source?.userId;
  const today = new Date().toISOString().slice(0, 10);

  /* ===== テキスト ===== */
  if (event.message.type === "text") {
    const text = event.message.text.trim();

    /* --- 1日の合計 --- */
    if (text === "1日の合計") {
      const r = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/food_logs?user_id=eq.${userId}&eaten_at=eq.${today}`,
        {
          headers: {
            apikey: process.env.SUPABASE_ANON_KEY,
            Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
          },
        }
      );
      const rows = await r.json();

      if (!rows.length) {
        await reply(replyToken, "今日はまだ食事ログがありません 🍽");
        return res.status(200).end();
      }

      let kcal = 0, p = 0, f = 0, c = 0;
      rows.forEach(x => {
        kcal += x.calories;
        p += x.protein;
        f += x.fat;
        c += x.carbs;
      });

      await reply(
        replyToken,
        `🍽 1日の合計（目安）

🔥 カロリー
約 ${Math.round(kcal)} kcal

🥗 PFCバランス
・たんぱく質：${p.toFixed(1)} g
・脂質：${f.toFixed(1)} g
・炭水化物：${c.toFixed(1)} g`
      );
      return res.status(200).end();
    }

    /* --- 料理/食材判定 --- */
    const judge = await openai(
      `${text} は料理名または食材名ですか？YESかNOのみで答えて`
    );

    if (judge !== "YES") {
      await reply(
        replyToken,
        "料理や食材をテキストか写真で送ると目安カロリーを知ることができます 📸🍽"
      );
      return res.status(200).end();
    }

    const result = await openai(
      `${text} のカロリーとPFC（たんぱく質・脂質・炭水化物）を数値で推定してください`
    );

    await reply(replyToken, `🍽 推定結果（目安）\n\n${result}`);
    await saveFromText(userId, text, result, today);
    return res.status(200).end();
  }

  /* ===== 画像 ===== */
  if (event.message.type === "image") {
    await reply(replyToken, "📸 解析中です…少しお待ちください");

    try {
      const img = await fetch(
        `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
        { headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } }
      );
      const buf = Buffer.from(await img.arrayBuffer());

      const form = new FormData();
      form.append("file", new Blob([buf]));
      form.append("upload_preset", process.env.CLOUDINARY_UPLOAD_PRESET);

      const up = await fetch(
        `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
        { method: "POST", body: form }
      );
      const { secure_url } = await up.json();

      const ai = await openaiJson([
        {
          role: "user",
          content: [
            { type: "input_text", text: "画像内の料理をすべて特定し、それぞれのカロリーとPFCを出し、合計も算出してください" },
            { type: "input_image", image_url: secure_url },
          ],
        },
      ]);

      const parsed = parseMultiFood(ai);
      await reply(replyToken, formatImageResult(parsed));
      for (const f of parsed.items) {
        await saveLog(userId, f.name, f, today);
      }
    } catch (e) {
      console.error(e);
      await reply(replyToken, "❌ 解析に失敗しました");
    }
  }

  res.status(200).end();
}

/* ===== OpenAI ===== */
async function openai(prompt) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: "gpt-4.1-mini", input: prompt }),
  });
  const j = await r.json();
  return extractText(j)?.trim() || "";
}

async function openaiJson(input) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: "gpt-4.1-mini", input }),
  });
  return await r.json();
}

/* ===== Supabase ===== */
async function saveLog(userId, name, f, date) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/food_logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      user_id: userId,
      food_name: name,
      calories: f.kcal,
      protein: f.p,
      fat: f.f,
      carbs: f.c,
      eaten_at: date,
    }),
  });
}

async function saveFromText(userId, name, text, date) {
  const n = text.match(/([\d.]+)/g) || [];
  await saveLog(userId, name, {
    kcal: Number(n[0] || 0),
    p: Number(n[1] || 0),
    f: Number(n[2] || 0),
    c: Number(n[3] || 0),
  }, date);
}

/* ===== utils ===== */
function extractText(ai) {
  for (const o of ai.output || []) {
    for (const c of o.content || []) {
      if (c.type === "output_text") return c.text;
    }
  }
  return null;
}

function parseMultiFood(ai) {
  const t = extractText(ai) || "";
  const items = [];
  let total = { kcal: 0, p: 0, f: 0, c: 0 };

  t.split("\n").forEach(l => {
    const m = l.match(/(.+):.*?([\d.]+).*?([\d.]+).*?([\d.]+).*?([\d.]+)/);
    if (m) {
      const f = {
        name: m[1],
        kcal: +m[2],
        p: +m[3],
        f: +m[4],
        c: +m[5],
      };
      items.push(f);
      total.kcal += f.kcal;
      total.p += f.p;
      total.f += f.f;
      total.c += f.c;
    }
  });

  return { total, items };
}

function formatImageResult(d) {
  let s =
`🍽 推定結果（目安）

【合計】
🔥 カロリー
約 ${Math.round(d.total.kcal)} kcal

🥗 PFCバランス
・たんぱく質：${d.total.p.toFixed(1)} g
・脂質：${d.total.f.toFixed(1)} g
・炭水化物：${d.total.c.toFixed(1)} g

【内訳】`;

  d.items.forEach(f => {
    s += `

${f.name}
・カロリー：約 ${f.kcal} kcal
・P：${f.p} g / F：${f.f} g / C：${f.c} g`;
  });
  return s;
}

/* ===== LINE ===== */
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
