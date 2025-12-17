export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const event = req.body?.events?.[0];
  if (!event) return res.status(200).end();

  const replyToken = event.replyToken;
  const userId = event.source?.userId;

  // ★JSTで「今日」を作る（重要）
  const today = getJstDate(); // YYYY-MM-DD (Asia/Tokyo)

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
      await saveFromText(userId, sanitizeFoodName(text), result || "", today);
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
- 推定でOK
              `.trim(),
            },
            { type: "input_image", image_url: imageUrl },
          ],
        },
      ]);

      const parsed = parseMultiFood(ai);
      const message = formatImageResult(parsed);

      if (userId) await push(userId, message);

      // ★保存前に name を必ずサニタイズ
      for (const f of parsed.items) {
        const cleanName = sanitizeFoodName(f.name);
        if (!cleanName) continue;
        await saveLog(userId, cleanName, f, today);
      }
    } catch (e) {
      console.error(e);
      if (userId) await push(userId, "❌ 解析に失敗しました");
    }

    return res.status(200).end();
  }

  res.status(200).end();
}

/* ===== JST日付（YYYY-MM-DD） ===== */
function getJstDate() {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const d = parts.find(p => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

/* ===== food_name サニタイズ ===== */
function sanitizeFoodName(name) {
  if (!name) return "";
  let s = String(name);

  // 改行以降は捨てる（混入防止）
  s = s.split("\n")[0];

  // 料理名以外のワードが入ってたらそこで切る
  const cutWords = ["カロリー", "PFC", "たんぱく質", "脂質", "炭水化物", "推定結果", "合計", "総計"];
  for (const w of cutWords) {
    const idx = s.indexOf(w);
    if (idx > 0) s = s.slice(0, idx);
  }

  // 先頭の番号や記号を除去
  s = s.replace(/^[\s]*[①-⑨0-9]+[)\]）\.．:\s-]*/g, "");
  s = s.replace(/^[\s]*[・\-–—]+/g, "");
  s = s.trim();

  // 長すぎる/空は弾く
  if (!s || s.length > 50) return s.slice(0, 50).trim();
  return s;
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
function extractText(aiData) {
  try {
    for (const item of aiData.output || []) {
      for (const c of item.content || []) {
        if (c.type === "output_text" && c.text) return c.text;
      }
    }
  } catch {}
  return null;
}

function tryParseJson(text) {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseMultiFood(ai) {
  const raw = extractText(ai) || "";
  const j = tryParseJson(raw);

  if (j && j.items && j.total) {
    const items = (j.items || [])
      .filter(x => x && x.name && !/合計|総計/i.test(String(x.name)))
      .map(x => ({
        name: String(x.name),
        kcal: Number(x.kcal || 0),
        p: Number(x.p || 0),
        f: Number(x.f || 0),
        c: Number(x.c || 0),
      }));

    const total = {
      kcal: Number(j.total.kcal || 0),
      p: Number(j.total.p || 0),
      f: Number(j.total.f || 0),
      c: Number(j.total.c || 0),
    };

    const calc = items.reduce(
      (a, x) => (a.kcal += x.kcal, a.p += x.p, a.f += x.f, a.c += x.c, a),
      { kcal: 0, p: 0, f: 0, c: 0 }
    );
    const fixedTotal = total.kcal > 0 ? total : calc;

    return { total: fixedTotal, items, point: String(j.point || ""), raw };
  }

  return { total: { kcal: 0, p: 0, f: 0, c: 0 }, items: [], point: "", raw };
}

function formatImageResult(d) {
  if (!d.items.length) return d.raw ? `🍽 推定結果（目安）\n\n${d.raw}` : "解析できませんでした";

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

${i + 1}) ${sanitizeFoodName(x.name)}
カロリー：約 ${Math.round(x.kcal)} kcal
PFC
・たんぱく質：${Number(x.p).toFixed(1)} g
・脂質：${Number(x.f).toFixed(1)} g
・炭水化物：${Number(x.c).toFixed(1)} g`;
  });

  s += `

✅ ポイント
${d.point || "量や具材で数値は変動します。必要なら量も送ると精度が上がります。"}`;

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
    body: JSON.stringify({ replyToken: token, messages: [{ type: "text", text }] }),
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
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  });
  if (!r.ok) console.log("LINE push failed:", r.status, await r.text());
}
