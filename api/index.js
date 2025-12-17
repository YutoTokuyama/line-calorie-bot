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
      try {
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
      } catch (e) {
        console.error(e);
        await reply(replyToken, "❌ 集計に失敗しました");
      }
      return res.status(200).end();
    }

    /* --- 料理/食材判定 --- */
    try {
      const judge = await openai(`${text} は料理名または食材名ですか？YESかNOのみで答えて`);
      if (judge !== "YES") {
        await reply(
          replyToken,
          "料理や食材をテキストか写真で送ると目安カロリーとPFCを知ることができます 📸🍽\n\n「1日の合計」と送ると今日の合計も確認できます。"
        );
        return res.status(200).end();
      }

      const result = await openai(
        `${text} のカロリーとPFC（たんぱく質・脂質・炭水化物）を数値で推定してください。簡潔に。`
      );

      await reply(replyToken, result ? `🍽 推定結果（目安）\n\n${result}` : "解析できませんでした");
      await saveFromText(userId, text, result || "", today);
    } catch (e) {
      console.error(e);
      await reply(replyToken, "❌ エラーが発生しました");
    }

    return res.status(200).end();
  }

  /* ===== 画像 ===== */
  if (event.message.type === "image") {
    // replyTokenは1回だけ使う（解析中）
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
      const upJson = await up.json();
      const imageUrl = upJson.secure_url;

      // ★ここが重要：JSON固定で返させる
      const ai = await openaiJson([
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `
あなたは栄養計算アシスタントです。画像から料理・食材をできるだけ特定し、推定のカロリーとPFCを出してください。
出力は「JSONのみ」。前後に説明文やコードブロックは禁止です（JSON以外の文字を出さない）。

【JSONスキーマ（厳守）】
{
  "total": { "kcal": number, "p": number, "f": number, "c": number },
  "items": [
    { "name": string, "kcal": number, "p": number, "f": number, "c": number }
  ],
  "point": string
}

ルール：
- itemsには合計を入れない（"合計"や"総計"はitemsに含めない）
- itemsは画像内に写っている料理/食材の数だけ入れる
- totalはitemsの合計と整合する値にする
- 推定でOK。数値は現実的な範囲にする
              `.trim(),
            },
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ]);

      const parsed = parseMultiFood(ai);
      const message = formatImageResult(parsed);

      // 結果は push で送る
      if (userId) await push(userId, message);

      // itemsだけ保存（totalは保存しない）
      for (const f of parsed.items) {
        await saveLog(userId, f.name, f, today);
      }
    } catch (e) {
      console.error(e);
      if (userId) await push(userId, "❌ 解析に失敗しました");
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
  if (!userId) return;
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/food_logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      food_name: name,
      calories: Math.round(Number(f.kcal || 0)),
      protein: Number(f.p || 0),
      fat: Number(f.f || 0),
      carbs: Number(f.c || 0),
      eaten_at: date,
    }),
  });
}

async function saveFromText(userId, name, text, date) {
  if (!userId) return;
  const n = (text || "").match(/([\d.]+)/g) || [];
  await saveLog(
    userId,
    name,
    { kcal: Number(n[0] || 0), p: Number(n[1] || 0), f: Number(n[2] || 0), c: Number(n[3] || 0) },
    date
  );
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

// ★JSON固定を優先。失敗したら最低限のフォールバック
function parseMultiFood(ai) {
  const raw = extractText(ai) || "";
  const parsedJson = tryParseJson(raw);

  if (parsedJson && parsedJson.items && parsedJson.total) {
    // itemsに合計が混ざらないよう二重ガード
    const items = (parsedJson.items || [])
      .filter(x => x && x.name && !/合計|総計/i.test(String(x.name)))
      .map(x => ({
        name: String(x.name),
        kcal: Number(x.kcal || 0),
        p: Number(x.p || 0),
        f: Number(x.f || 0),
        c: Number(x.c || 0),
      }));

    const total = {
      kcal: Number(parsedJson.total.kcal || 0),
      p: Number(parsedJson.total.p || 0),
      f: Number(parsedJson.total.f || 0),
      c: Number(parsedJson.total.c || 0),
    };

    // totalが空っぽ/不整合なら items から再計算
    const calc = items.reduce(
      (a, x) => (a.kcal += x.kcal, a.p += x.p, a.f += x.f, a.c += x.c, a),
      { kcal: 0, p: 0, f: 0, c: 0 }
    );
    const fixedTotal =
      total.kcal > 0 ? total : calc;

    return {
      total: fixedTotal,
      items,
      point: String(parsedJson.point || ""),
      raw,
    };
  }

  // フォールバック：返答そのまま（「返ってこない」を防ぐ）
  return { total: { kcal: 0, p: 0, f: 0, c: 0 }, items: [], point: "", raw };
}

function tryParseJson(text) {
  try {
    // 返答のどこかにJSONがあっても拾う
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    const jsonStr = text.slice(start, end + 1);
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function formatImageResult(d) {
  // JSONパース失敗時は raw をそのまま返す
  if (!d.items.length) {
    return d.raw ? `🍽 推定結果（目安）\n\n${d.raw}` : "解析できませんでした";
  }

  let s =
`🍽 推定結果（目安）

🔥 合計
カロリー：約 ${Math.round(d.total.kcal)} kcal
PFC
・たんぱく質：${d.total.p.toFixed(1)} g
・脂質：${d.total.f.toFixed(1)} g
・炭水化物：${d.total.c.toFixed(1)} g

――――――――――
【内訳】`;

  d.items.forEach((x, i) => {
    s += `

${i + 1}) ${x.name}
カロリー：約 ${Math.round(x.kcal)} kcal
PFC
・たんぱく質：${Number(x.p).toFixed(1)} g
・脂質：${Number(x.f).toFixed(1)} g
・炭水化物：${Number(x.c).toFixed(1)} g`;
  });

  if (d.point) {
    s += `

✅ ポイント
${d.point}`;
  } else {
    s += `

✅ ポイント
量や具材で数値は変動します。必要なら「ご飯150g」「唐揚げ3個」など量も送ると精度が上がります。`;
  }

  return s;
}

/* ===== LINE ===== */
async function reply(token, text) {
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
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
  if (!r.ok) console.log("LINE reply failed:", r.status, await r.text());
}

async function push(userId, text) {
  const r = await fetch("https://api.line.me/v2/bot/message/push", {
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
  if (!r.ok) console.log("LINE push failed:", r.status, await r.text());
}
