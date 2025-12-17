export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const event = req.body?.events?.[0];
  if (!event) return res.status(200).end();

  const replyToken = event.replyToken;
  const userId = event.source?.userId;
  const today = new Date().toISOString().slice(0, 10);

  /* ===== テキスト ===== */
  if (event.message.type === "text") {
    const userText = event.message.text.trim();

    /* === 1日の合計 === */
    if (userText === "1日の合計") {
      try {
        const sumRes = await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/food_logs?user_id=eq.${userId}&eaten_at=eq.${today}`,
          {
            headers: {
              apikey: process.env.SUPABASE_ANON_KEY,
              Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
            },
          }
        );

        const rows = await sumRes.json();
        if (!rows.length) {
          await reply(replyToken, "今日はまだ食事ログがありません 🍽");
          return res.status(200).end();
        }

        let kcal = 0, p = 0, f = 0, c = 0;
        rows.forEach(r => {
          kcal += r.calories;
          p += r.protein;
          f += r.fat;
          c += r.carbs;
        });

        await reply(
          replyToken,
          `🍽 1日の合計（目安）

🔥 カロリー
約 ${Math.round(kcal)} kcal

🥗 PFC
・たんぱく質：${p.toFixed(1)} g
・脂質：${f.toFixed(1)} g
・炭水化物：${c.toFixed(1)} g`
        );
      } catch (e) {
        console.error(e);
        await reply(replyToken, "❌ 集計に失敗しました");
      }

      return res.status(200).end();
    }

    /* === 料理/食材 判定 === */
    try {
      const judgeRes = await openai(`${userText} は料理名または食材名ですか？YESかNOで答えて`);
      if (judgeRes !== "YES") {
        await reply(
          replyToken,
          "料理や食材をテキストか写真で送ると目安カロリーを知ることができます 📸🍽"
        );
        return res.status(200).end();
      }

      const result = await openai(
        `${userText} のカロリーとPFCを数値で推定してください`
      );

      await reply(replyToken, `🍽 推定結果（目安）\n\n${result}`);

      await saveLog(userId, userText, result, today);
    } catch (e) {
      console.error(e);
      await reply(replyToken, "❌ エラーが発生しました");
    }

    return res.status(200).end();
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
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: prompt,
    }),
  });

  const j = await r.json();
  return extractText(j)?.trim() || "";
}

/* ===== Supabase 保存 ===== */
async function saveLog(userId, name, text, date) {
  const nums = text.match(/([\d.]+)/g) || [];
  const body = {
    user_id: userId,
    food_name: name,
    calories: Number(nums[0] || 0),
    protein: Number(nums[1] || 0),
    fat: Number(nums[2] || 0),
    carbs: Number(nums[3] || 0),
    eaten_at: date,
  };

  await fetch(`${process.env.SUPABASE_URL}/rest/v1/food_logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
}

/* ===== LINE reply ===== */
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

/* ===== OpenAI text抽出 ===== */
function extractText(aiData) {
  try {
    for (const item of aiData.output || []) {
      for (const c of item.content || []) {
        if (c.type === "output_text") return c.text;
      }
    }
  } catch {}
  return null;
}
