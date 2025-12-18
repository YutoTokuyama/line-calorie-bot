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
    const lineMessageId = event.message.id; // 保存のidempotency用（結果返信は毎回する）

    // 日付指定合計
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

    // 1日の合計
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

    // ✅ 同じテキストでも毎回結果が返る（重複判定で弾かない）
    await reply(replyToken, "⌨️ 解析中です…少しお待ちください");

    // 料理判定
    const judge = await openai(`${text} は料理名または食材名ですか？YESかNOのみで答えて`);
    if (judge !== "YES") {
      await push(
        userId,
        "料理や食材をテキストか写真で送ると、目安カロリーとPFCを知ることができます 📸🍽"
      );
      return;
    }

    const ai = await openaiJsonTextFood(text);
    const parsed = parseSingleFood(ai, text);

    // 0kcalっぽい失敗時は保存しない
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
      null // image_hashなし
    );
    return;
  }

  /* ===== 画像 ===== */
  if (event.message.type === "image") {
    const lineMessageId = event.message.id;

    // webhook再送（同一 message.id）は即return（通知スパム防止）
    if (await existsLogForMessage(userId, lineMessageId)) return;

    // 画像取得 → hash作成（手動で同じ画像でも検知できる）
    const imgRes = await fetch(
      `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
      { headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const imageHash = crypto.createHash("sha256").update(buf).digest("hex");

    // ✅ 同日内で同じ画像がすでに登録されていたら計算しない
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

    // ✅ 0kcal（=パース失敗）なら結果を返さない＆保存しない
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
  // ✅ 画像もテキスト同様に「厳格JSONスキーマ」を要求
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
- 分からない場合でも items を空にしない（最も近い料理名で推定する）
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
      // ✅ JSONモード（壊れた出力を減らす）
      text: { format: { type: "json_object" } },
    }),
  });

  const j = await r.json();

  // OpenAI側エラーが混ざると 0kcal になりがちなのでログに出す
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

function parseMultiFood(ai) {
  const j = tryParseJson(extractText(ai));
  const items = (j?.items || []).map(x => ({
    name: x.name,
    kcal: +x.kcal,
    p: +x.p,
    f: +x.f,
    c: +x.c,
  }));
  const total = sumRows(items);
  return { items, total, point: j?.point || "" };
}

function parseSingleFood(ai, fallback) {
  const j = tryParseJson(extractText(ai));
  const item = j?.items?.[0] || { name: fallback, kcal: 0, p: 0, f: 0, c: 0 };
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

function formatTotalMessage(date, t) {
  return `🍽 ${date} の合計（目安）

🔥 カロリー
約 ${Math.round(t.kcal)} kcal

🥗 PFCバランス
・たんぱく質：${t.p.toFixed(1)} g
・脂質：${t.f.toFixed(1)} g
・炭水化物：${t.c.toFixed(1)} g`;
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
約 ${Math.round(d.total.kcal)} kcal`;
  d.items.forEach((x, i) => {
    s += `

${i + 1}) ${x.name}
約 ${Math.round(x.kcal)} kcal`;
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
