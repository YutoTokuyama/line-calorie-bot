import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const events = req.body?.events || [];
  if (!events.length) return res.status(200).end();

  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (e) {
      console.error("event error:", e);
    }
  }
  res.status(200).end();
}

/* ===============================
   メイン処理
================================ */
async function handleEvent(event) {
  const replyToken = event.replyToken;
  const userId = event.source?.userId;
  if (!event.message || !userId) return;

  const today = getJstDate();

  /* ===== テキスト ===== */
  if (event.message.type === "text") {
    const text = event.message.text.trim();
    const lineMessageId = event.message.id;

    // ✅ 期間指定（例: 2025-12-01：2025-12-07）
    const range = parseRangeDate(text);
    if (range) {
      const { start, end } = range;

      await reply(replyToken, "📊 期間集計中です…少しお待ちください");
      const rows = await fetchFoodLogsRange(userId, start, end);

      if (!rows.length) {
        await push(userId, `📭 ${start}〜${end} の期間に食事ログはありません 🍽`);
        return;
      }

      const total = sumRows(rows);
      const daysMeasured = countDistinctDays(rows); // ✅ ログがある日だけ数える
      const avg = divideTotal(total, daysMeasured);

      await push(userId, formatRangeMeasuredMessage(start, end, daysMeasured, total, avg));
      return;
    }

    // 日付指定合計（単日）
    const sumDate = parseSumDate(text);
    if (sumDate) {
      await reply(replyToken, "📊 集計中です…少しお待ちください");
      const rows = await fetchFoodLogs(userId, sumDate);
      if (!rows.length) {
        await push(userId, `${sumDate} に食事ログはありません 🍽`);
        return;
      }
      const total = sumRows(rows);
      await push(userId, formatTotalMessage(sumDate, total));
      return;
    }

    // 1日の合計（今日）
    if (text === "1日の合計") {
      await reply(replyToken, "📊 集計中です…少しお待ちください");
      const rows = await fetchFoodLogs(userId, today);
      if (!rows.length) {
        await push(userId, "今日はまだ食事ログがありません 🍽");
        return;
      }
      const total = sumRows(rows);
      await push(userId, formatTotalMessage(today, total));
      return;
    }

    // ✅ 同じテキストでも毎回結果を返す
    await reply(replyToken, "⌨️ 解析中です…少しお待ちください");

    const judge = await openai(`${text} は料理名または食材名ですか？YESかNOのみで答えて`);
    if (judge !== "YES") {
      await push(
        userId,
        "料理や食材をテキストか写真で送ると、目安カロリーとPFCを知ることができます 📸🍽\n\n例）\n・カレー\n・2025-12-01：2025-12-07"
      );
      return;
    }

    const ai = await openaiJsonTextFood(text);
    const parsed = parseSingleFood(ai, text);

    if (!parsed.item || !isFiniteNumber(parsed.item.kcal) || parsed.item.kcal <= 0) {
      console.error("text parse failed:", extractText(ai));
      await push(userId, "⚠️ 解析に失敗しました。少し表現を変えてもう一度送ってください。");
      return;
    }

    await push(userId, formatTextResult(parsed));

    await saveLog(
      userId,
      sanitizeFoodName(parsed.item.name),
      parsed.item,
      today,
      lineMessageId,
      1,
      null
    );
    return;
  }

  /* ===== 画像 ===== */
  if (event.message.type === "image") {
    const lineMessageId = event.message.id;

    // webhook再送（同一 message.id）は即return（通知スパム防止）
    if (await existsLogForMessage(userId, lineMessageId)) return;

    // 画像取得 → hash作成（手動で同じ画像でも検知）
    const imgRes = await fetch(
      `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
      { headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const imageHash = crypto.createHash("sha256").update(buf).digest("hex");

    // ✅ 同日内の同一画像は計算しない
    if (await existsImageHashForDate(userId, today, imageHash)) {
      await push(userId, "🔁 同じ画像が送られたため、今回は計算しませんでした。");
      return;
    }

    await reply(replyToken, "📸 解析中です…少しお待ちください");

    // Cloudinaryへアップ（重複じゃない時だけ）
    const form = new FormData();
    form.append("file", new Blob([buf]));
    form.append("upload_preset", process.env.CLOUDINARY_UPLOAD_PRESET);

    const up = await fetch(
      `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
      { method: "POST", body: form }
    );
    const upJson = await up.json();
    const imageUrl = upJson.secure_url;

    const ai = await openaiJsonImage(imageUrl);
    const parsed = parseMultiFood(ai);

    if (!parsed.items.length || !isFiniteNumber(parsed.total.kcal) || parsed.total.kcal <= 0) {
      console.error("image parse failed output_text:", extractText(ai));
      await push(
        userId,
        "⚠️ 画像の解析に失敗しました。料理がはっきり写るように撮り直して、もう一度送ってください。"
      );
      return;
    }

    await push(userId, formatImageResult(parsed));

    for (let i = 0; i < parsed.items.length; i++) {
      const f = parsed.items[i];
      await saveLog(
        userId,
        sanitizeFoodName(f.name),
        f,
        today,
        lineMessageId,
        i + 1,
        imageHash
      );
    }
  }
}

/* ===============================
   OpenAI
================================ */
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
  return extractText(j)?.trim();
}

async function openaiJsonTextFood(text) {
  return openaiJson(`
出力はJSONのみ。前後に説明文は禁止。

{
 "total": { "kcal": number, "p": number, "f": number, "c": number },
 "items": [{ "name": string, "kcal": number, "p": number, "f": number, "c": number }],
 "point": string
}

ルール:
- 原則 items は1件（料理名そのもの）
- 材料分解は禁止
- totalはitems合計と一致

料理名:
${text}
`);
}

async function openaiJsonImage(imageUrl) {
  const prompt = `
出力はJSONのみ。前後に説明文は禁止。

{
 "total": { "kcal": number, "p": number, "f": number, "c": number },
 "items": [{ "name": string, "kcal": number, "p": number, "f": number, "c": number }],
 "point": string
}

ルール:
- 写真に写っている料理を items に列挙（1〜6件程度）
- 材料分解は禁止（料理単位）
- 数値は必ず0より大きい現実的な推定値
- totalはitems合計と一致
`;

  return openaiJson([
    {
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        { type: "input_image", image_url: imageUrl },
      ],
    },
  ]);
}

async function openaiJson(input) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input,
      temperature: 0.2,
      text: { format: { type: "json_object" } },
    }),
  });

  const j = await r.json();
  if (!r.ok) console.error("openaiJson error:", j);
  return j;
}

/* ===============================
   Supabase
================================ */
async function saveLog(userId, name, f, date, lineMessageId, itemIndex, imageHash) {
  const url =
    `${process.env.SUPABASE_URL}/rest/v1/food_logs` +
    `?on_conflict=user_id,line_message_id,item_index`;

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      food_name: name,
      calories: Math.round(f.kcal),
      protein: f.p,
      fat: f.f,
      carbs: f.c,
      eaten_at: date,
      line_message_id: lineMessageId,
      item_index: itemIndex,
      image_hash: imageHash,
    }),
  });
}

async function fetchFoodLogs(userId, date) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/food_logs?user_id=eq.${encodeURIComponent(
    userId
  )}&eaten_at=eq.${date}`;
  const r = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
    },
  });
  return await r.json();
}

async function fetchFoodLogsRange(userId, start, end) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/food_logs?user_id=eq.${encodeURIComponent(
    userId
  )}&eaten_at=gte.${start}&eaten_at=lte.${end}`;

  const r = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
    },
  });
  return await r.json();
}

async function existsLogForMessage(userId, lineMessageId) {
  if (!userId || !lineMessageId) return false;

  const url = `${process.env.SUPABASE_URL}/rest/v1/food_logs?select=id&user_id=eq.${encodeURIComponent(
    userId
  )}&line_message_id=eq.${encodeURIComponent(lineMessageId)}&limit=1`;

  const r = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
    },
  });

  const j = await r.json().catch(() => []);
  return Array.isArray(j) && j.length > 0;
}

async function existsImageHashForDate(userId, date, imageHash) {
  if (!userId || !date || !imageHash) return false;

  const url = `${process.env.SUPABASE_URL}/rest/v1/food_logs?select=id&user_id=eq.${encodeURIComponent(
    userId
  )}&eaten_at=eq.${date}&image_hash=eq.${encodeURIComponent(imageHash)}&limit=1`;

  const r = await fetch(url, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
    },
  });

  const j = await r.json().catch(() => []);
  return Array.isArray(j) && j.length > 0;
}

/* ===============================
   JST 日付（完全安定）
================================ */
function getJstDate() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

function shiftJstDate(days) {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

function parseSumDate(text) {
  if (!text.includes("合計")) return null;
  if (text === "昨日の合計") return shiftJstDate(-1);
  if (text === "一昨日の合計") return shiftJstDate(-2);
  if (text === "今日の合計") return getJstDate();

  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

// ✅ 「2025-12-01：2025-12-07」みたいに区切りだけでも反応させる
function parseRangeDate(text) {
  const m = text.match(/(\d{4}-\d{2}-\d{2}).*?(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;

  let start = m[1];
  let end = m[2];

  if (!isValidIsoDate(start) || !isValidIsoDate(end)) return null;
  if (start > end) [start, end] = [end, start];
  return { start, end };
}

function isValidIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/* ===============================
   パース & 表示
================================ */
function extractText(ai) {
  for (const o of ai.output || []) {
    for (const c of o.content || []) {
      if (c.type === "output_text") return c.text;
    }
  }
  return "";
}

function tryParseJson(t) {
  try {
    return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseMultiFood(ai) {
  const j = tryParseJson(extractText(ai));
  const items = (j?.items || []).map(x => ({
    name: x.name,
    kcal: num(x.kcal ?? x.calories),
    p: num(x.p ?? x.protein),
    f: num(x.f ?? x.fat),
    c: num(x.c ?? x.carbs),
  }));
  const total = sumRows(items);
  return { items, total, point: j?.point || "" };
}

function parseSingleFood(ai, fallback) {
  const j = tryParseJson(extractText(ai));
  const raw = j?.items?.[0] || { name: fallback, kcal: 0, p: 0, f: 0, c: 0 };
  const item = {
    name: raw.name ?? fallback,
    kcal: num(raw.kcal ?? raw.calories),
    p: num(raw.p ?? raw.protein),
    f: num(raw.f ?? raw.fat),
    c: num(raw.c ?? raw.carbs),
  };
  return { item, total: item, point: j?.point || "" };
}

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function sumRows(rows) {
  return rows.reduce(
    (a, x) => {
      const kcal = (x.calories ?? x.kcal ?? 0);
      const p = (x.protein ?? x.p ?? 0);
      const f = (x.fat ?? x.f ?? 0);
      const c = (x.carbs ?? x.c ?? 0);
      return {
        kcal: a.kcal + kcal,
        p: a.p + p,
        f: a.f + f,
        c: a.c + c,
      };
    },
    { kcal: 0, p: 0, f: 0, c: 0 }
  );
}

function countDistinctDays(rows) {
  const set = new Set();
  for (const r of rows) {
    if (r?.eaten_at) set.add(String(r.eaten_at));
  }
  return set.size || 1;
}

function divideTotal(t, days) {
  const d = Math.max(1, days || 1);
  return { kcal: t.kcal / d, p: t.p / d, f: t.f / d, c: t.c / d };
}

function formatTotalMessage(date, t) {
  return `🍽 ${date} の合計（目安）

🔥 カロリー
約 ${Math.round(t.kcal)} kcal

🥗 PFCバランス
・たんぱく質：${t.p.toFixed(1)} g
・脂質：${t.f.toFixed(1)} g
・炭水化物：${t.c.toFixed(1)} g`;
}

function formatRangeMeasuredMessage(start, end, daysMeasured, total, avg) {
  return `📅 ${start}〜${end} の集計

🗓 計測日数：${daysMeasured} 日（ログがある日だけ）

【合計】
🔥 カロリー：約 ${Math.round(total.kcal)} kcal
🥗 PFC：
・たんぱく質：${total.p.toFixed(1)} g
・脂質：${total.f.toFixed(1)} g
・炭水化物：${total.c.toFixed(1)} g

【1日あたり平均】
🔥 カロリー：${Math.round(avg.kcal)} kcal/日
🥗 PFC：
・たんぱく質：${avg.p.toFixed(1)} g/日
・脂質：${avg.f.toFixed(1)} g/日
・炭水化物：${avg.c.toFixed(1)} g/日`;
}

function formatTextResult(d) {
  return `🍽 推定結果（目安）

🔥 カロリー
約 ${Math.round(d.item.kcal)} kcal

🥗 PFCバランス
・たんぱく質：${d.item.p.toFixed(1)} g
・脂質：${d.item.f.toFixed(1)} g
・炭水化物：${d.item.c.toFixed(1)} g

✅ ポイント
${d.point || "量や具材で数値は変動します。"}`;
}

function formatImageResult(d) {
  let s = `🍽 推定結果（目安）

🔥 合計
約 ${Math.round(d.total.kcal)} kcal

🥗 合計PFC
・たんぱく質：${d.total.p.toFixed(1)} g
・脂質：${d.total.f.toFixed(1)} g
・炭水化物：${d.total.c.toFixed(1)} g`;

  d.items.forEach((x, i) => {
    s += `

${i + 1}) ${x.name}
約 ${Math.round(x.kcal)} kcal
P:${x.p.toFixed(1)}g F:${x.f.toFixed(1)}g C:${x.c.toFixed(1)}g`;
  });

  return s;
}

function sanitizeFoodName(n) {
  return String(n || "").split("\n")[0].trim().slice(0, 50);
}

/* ===============================
   LINE
================================ */
async function reply(token, text) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken: token, messages: [{ type: "text", text }] }),
  });
}

async function push(userId, text) {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  });
}
