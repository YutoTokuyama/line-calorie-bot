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

    // ✅ 目標設定（A: 最小）
    const goalSet = parseGoalSet(text);
    if (goalSet) {
      await reply(replyToken, "⚙️ 設定中です…");
      await upsertGoal(userId, goalSet);
      await push(
        userId,
        `✅ 目標カロリーを設定しました\n\n🎯 1日目標：${goalSet} kcal\n※変更：目標 1800\n※解除：目標解除`
      );
      return;
    }

    // ✅ 目標解除
    if (isGoalClear(text)) {
      await reply(replyToken, "⚙️ 解除中です…");
      await deleteGoal(userId);
      await push(userId, "✅ 目標カロリーを解除しました");
      return;
    }

    // ✅ 直前取り消し
    if (isUndoCommand(text)) {
      await reply(replyToken, "🗑 直前の記録を取り消し中です…");

      const last = await fetchLastLogMeta(userId);
      if (!last) {
        await push(userId, "取り消せる記録がありません。");
        return;
      }

      let logsToDelete = [];
      if (last.line_message_id) {
        logsToDelete = await fetchLogsByMessage(userId, last.line_message_id);
      } else if (last.id) {
        logsToDelete = await fetchLogsById(userId, last.id);
      }

      if (!logsToDelete.length) {
        await push(userId, "取り消せる記録が見つかりませんでした。");
        return;
      }

      const total = sumRows(logsToDelete);
      const eatenAt = logsToDelete[0]?.eaten_at || last.eaten_at || today;

      if (last.line_message_id) {
        await deleteLogsByMessage(userId, last.line_message_id);
      } else if (last.id) {
        await deleteLogById(userId, last.id);
      }

      await push(userId, formatUndoMessage(eatenAt, logsToDelete.length, total, logsToDelete));
      return;
    }

    // ✅ コーチだけ欲しい時（任意）
    if (isCoachCommand(text)) {
      await reply(replyToken, "🤖 コーチ作成中です…");
      const rows = await fetchFoodLogs(userId, today);
      if (!rows.length) {
        await push(userId, "今日はまだ食事ログがありません 🍽");
        return;
      }
      const total = sumRows(rows);
      const goal = await fetchGoal(userId);

      const coach = await getCoachCached({
        userId,
        cacheKey: `day:${today}:coachonly`,
        rows,
        scope: "day",
        dateLabel: today,
        totalKcal: total.kcal,
        totalP: total.p,
        totalF: total.f,
        totalC: total.c,
        goalKcal: goal?.calorie_goal ?? null,
      });

      await push(userId, coach || "🤖 コーチ：アドバイスを作れませんでした（もう一度お試しください）");
      return;
    }

    // ✅ 期間指定 → 平均ベースでコーチ
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
      const daysMeasured = countDistinctDays(rows);
      const avg = divideTotal(total, daysMeasured);

      const goal = await fetchGoal(userId);
      const msg = formatRangeMeasuredMessage(start, end, daysMeasured, total, avg, goal?.calorie_goal);

      const coach = await getCoachCached({
        userId,
        cacheKey: `range:${start}:${end}:avg`,
        rows, // 範囲内ログが更新されたら自動で再生成
        scope: "range",
        dateLabel: `${start}〜${end}（平均）`,
        totalKcal: avg.kcal,
        totalP: avg.p,
        totalF: avg.f,
        totalC: avg.c,
        goalKcal: goal?.calorie_goal ?? null,
      });

      await push(userId, msg + (coach ? `\n\n${coach}` : ""));
      return;
    }

    // ✅ 日付指定合計（単日）
    const sumDate = parseSumDate(text);
    if (sumDate) {
      await reply(replyToken, "📊 集計中です…少しお待ちください");
      const rows = await fetchFoodLogs(userId, sumDate);
      if (!rows.length) {
        await push(userId, `${sumDate} に食事ログはありません 🍽`);
        return;
      }
      const total = sumRows(rows);

      const goal = await fetchGoal(userId);
      const msg = formatTotalMessage(sumDate, total, goal?.calorie_goal);

      const coach = await getCoachCached({
        userId,
        cacheKey: `day:${sumDate}`,
        rows,
        scope: "day",
        dateLabel: sumDate,
        totalKcal: total.kcal,
        totalP: total.p,
        totalF: total.f,
        totalC: total.c,
        goalKcal: goal?.calorie_goal ?? null,
      });

      await push(userId, msg + (coach ? `\n\n${coach}` : ""));
      return;
    }

    // ✅ 今日の合計
    if (text === "1日の合計" || text === "今日の合計") {
      await reply(replyToken, "📊 集計中です…少しお待ちください");
      const rows = await fetchFoodLogs(userId, today);
      if (!rows.length) {
        await push(userId, "今日はまだ食事ログがありません 🍽");
        return;
      }
      const total = sumRows(rows);

      const goal = await fetchGoal(userId);
      const msg = formatTotalMessage(today, total, goal?.calorie_goal);

      const coach = await getCoachCached({
        userId,
        cacheKey: `day:${today}`,
        rows,
        scope: "day",
        dateLabel: today,
        totalKcal: total.kcal,
        totalP: total.p,
        totalF: total.f,
        totalC: total.c,
        goalKcal: goal?.calorie_goal ?? null,
      });

      await push(userId, msg + (coach ? `\n\n${coach}` : ""));
      return;
    }

    // ✅ 食事推定（テキスト）
    await reply(replyToken, "⌨️ 解析中です…少しお待ちください");

    const judge = await openai(`${text} は料理名または食材名ですか？YESかNOのみで答えて`);
    if (judge !== "YES") {
      await push(
        userId,
        "料理や食材をテキストか写真で送ると、目安カロリーとPFCを知ることができます 📸🍽\n\n例）\n・カレー\n・2025-12-01：2025-12-07\n・目標 2000\n・目標解除\n・直前を取り消し\n・コーチ"
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

    if (await existsLogForMessage(userId, lineMessageId)) return;

    const imgRes = await fetch(
      `https://api-data.line.me/v2/bot/message/${event.message.id}/content`,
      { headers: { Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const imageHash = crypto.createHash("sha256").update(buf).digest("hex");

    const today = getJstDate();
    if (await existsImageHashForDate(userId, today, imageHash)) {
      await push(userId, "🔁 同じ画像が送られたため、今回は計算しませんでした。");
      return;
    }

    await reply(replyToken, "📸 解析中です…少しお待ちください");

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
      temperature: 0.25,
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
function getSupabaseKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
}

function supabaseHeaders() {
  const key = getSupabaseKey();
  return {
    "Content-Type": "application/json",
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

async function saveLog(userId, name, f, date, lineMessageId, itemIndex, imageHash) {
  const url =
    `${process.env.SUPABASE_URL}/rest/v1/food_logs` +
    `?on_conflict=user_id,line_message_id,item_index`;

  await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
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

  const r = await fetch(url, { headers: supabaseHeaders() });
  return await r.json();
}

async function fetchFoodLogsRange(userId, start, end) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/food_logs?user_id=eq.${encodeURIComponent(
    userId
  )}&eaten_at=gte.${start}&eaten_at=lte.${end}`;

  const r = await fetch(url, { headers: supabaseHeaders() });
  return await r.json();
}

async function existsLogForMessage(userId, lineMessageId) {
  if (!userId || !lineMessageId) return false;

  const url = `${process.env.SUPABASE_URL}/rest/v1/food_logs?select=id&user_id=eq.${encodeURIComponent(
    userId
  )}&line_message_id=eq.${encodeURIComponent(lineMessageId)}&limit=1`;

  const r = await fetch(url, { headers: supabaseHeaders() });
  const j = await r.json().catch(() => []);
  return Array.isArray(j) && j.length > 0;
}

async function existsImageHashForDate(userId, date, imageHash) {
  if (!userId || !date || !imageHash) return false;

  const url = `${process.env.SUPABASE_URL}/rest/v1/food_logs?select=id&user_id=eq.${encodeURIComponent(
    userId
  )}&eaten_at=eq.${date}&image_hash=eq.${encodeURIComponent(imageHash)}&limit=1`;

  const r = await fetch(url, { headers: supabaseHeaders() });
  const j = await r.json().catch(() => []);
  return Array.isArray(j) && j.length > 0;
}

/* ---- 目標（user_goals） ---- */
async function upsertGoal(userId, calorieGoal) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/user_goals?on_conflict=user_id`;
  await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      calorie_goal: calorieGoal,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function deleteGoal(userId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/user_goals?user_id=eq.${encodeURIComponent(userId)}`;
  await fetch(url, { method: "DELETE", headers: supabaseHeaders() });
}

async function fetchGoal(userId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/user_goals?select=calorie_goal&user_id=eq.${encodeURIComponent(
    userId
  )}&limit=1`;

  const r = await fetch(url, { headers: supabaseHeaders() });
  const j = await r.json().catch(() => []);
  return Array.isArray(j) && j.length ? j[0] : null;
}

/* ---- コーチキャッシュ（user_coach_cache） ---- */
async function fetchCoachCache(userId, cacheKey) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/user_coach_cache?select=base_last_created_at,input_hash,coach_text&user_id=eq.${encodeURIComponent(
    userId
  )}&cache_key=eq.${encodeURIComponent(cacheKey)}&limit=1`;

  const r = await fetch(url, { headers: supabaseHeaders() });
  const j = await r.json().catch(() => []);
  return Array.isArray(j) && j.length ? j[0] : null;
}

async function upsertCoachCache(userId, cacheKey, baseLastCreatedAt, inputHash, coachText) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/user_coach_cache?on_conflict=user_id,cache_key`;
  await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      user_id: userId,
      cache_key: cacheKey,
      base_last_created_at: baseLastCreatedAt,
      input_hash: inputHash,
      coach_text: coachText,
      updated_at: new Date().toISOString(),
    }),
  });
}

/* ---- 直前取り消し用 ---- */
async function fetchLastLogMeta(userId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/food_logs?select=id,line_message_id,eaten_at,created_at&user_id=eq.${encodeURIComponent(
    userId
  )}&order=created_at.desc&limit=1`;

  const r = await fetch(url, { headers: supabaseHeaders() });
  const j = await r.json().catch(() => []);
  return Array.isArray(j) && j.length ? j[0] : null;
}

async function fetchLogsByMessage(userId, lineMessageId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/food_logs?select=food_name,calories,protein,fat,carbs,eaten_at,item_index&user_id=eq.${encodeURIComponent(
    userId
  )}&line_message_id=eq.${encodeURIComponent(lineMessageId)}&order=item_index.asc`;

  const r = await fetch(url, { headers: supabaseHeaders() });
  return await r.json().catch(() => []);
}

async function fetchLogsById(userId, id) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/food_logs?select=food_name,calories,protein,fat,carbs,eaten_at,item_index&user_id=eq.${encodeURIComponent(
    userId
  )}&id=eq.${encodeURIComponent(id)}&limit=1`;

  const r = await fetch(url, { headers: supabaseHeaders() });
  return await r.json().catch(() => []);
}

async function deleteLogsByMessage(userId, lineMessageId) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/food_logs?user_id=eq.${encodeURIComponent(
    userId
  )}&line_message_id=eq.${encodeURIComponent(lineMessageId)}`;

  await fetch(url, { method: "DELETE", headers: supabaseHeaders() });
}

async function deleteLogById(userId, id) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/food_logs?user_id=eq.${encodeURIComponent(
    userId
  )}&id=eq.${encodeURIComponent(id)}`;

  await fetch(url, { method: "DELETE", headers: supabaseHeaders() });
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

function isUndoCommand(text) {
  const t = text.replace(/\s+/g, "");
  return (
    t === "直前を取り消し" ||
    t === "直前を取消し" ||
    t === "直前を削除" ||
    t === "取り消し" ||
    t === "取消し"
  );
}

/* ---- 目標コマンド ---- */
function parseGoalSet(text) {
  const t = text.replace(/\s+/g, "");
  const m = t.match(/^(目標|カロリー目標)([:：=＝は]?)(\d{3,5})$/);
  if (m) return clampGoal(+m[3]);

  const m2 = text.match(/(目標|カロリー目標)\s*[:：=＝は]?\s*(\d{3,5})/);
  if (m2) return clampGoal(+m2[2]);

  return null;
}

function clampGoal(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 200) return 200;
  if (n > 10000) return 10000;
  return Math.round(n);
}

function isGoalClear(text) {
  const t = text.replace(/\s+/g, "");
  return t === "目標解除" || t === "目標を解除" || t === "カロリー目標解除" || t === "目標削除";
}

function isCoachCommand(text) {
  const t = text.replace(/\s+/g, "");
  return t === "コーチ" || t === "アドバイス" || t === "提案" || t === "コーチして";
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

/* ---- 目標表示 ---- */
function formatGoalBlockFromKcal(goalKcal, intakeKcal, label = "🎯 1日目標") {
  if (!goalKcal || !Number.isFinite(goalKcal)) return "";
  const rate = Math.round((intakeKcal / goalKcal) * 100);
  const remain = Math.round(goalKcal - intakeKcal);
  const remainText = remain >= 0 ? `${remain} kcal` : `${remain} kcal（超過）`;
  return `

${label}：${goalKcal} kcal
📊 摂取率：${rate}%
🧮 残り：${remainText}`;
}

function formatTotalMessage(date, t, goalKcal) {
  const base = `🍽 ${date} の合計（目安）

🔥 カロリー
約 ${Math.round(t.kcal)} kcal

🥗 PFCバランス
・たんぱく質：${t.p.toFixed(1)} g
・脂質：${t.f.toFixed(1)} g
・炭水化物：${t.c.toFixed(1)} g`;

  const goal = goalKcal ? formatGoalBlockFromKcal(goalKcal, t.kcal, "🎯 1日目標") : "";
  return base + goal;
}

function formatRangeMeasuredMessage(start, end, daysMeasured, total, avg, goalKcal) {
  const base = `📅 ${start}〜${end} の集計

🗓 計測日数：${daysMeasured} 日（ログがある日だけ）

【合計】
🔥 カロリー：約 ${Math.round(total.kcal)} kcal
🥗 PFC
・たんぱく質：${total.p.toFixed(1)} g
・脂質：${total.f.toFixed(1)} g
・炭水化物：${total.c.toFixed(1)} g

【1日あたり平均（計測日ベース）】
🔥 カロリー：${Math.round(avg.kcal)} kcal/日
🥗 PFC
・たんぱく質：${avg.p.toFixed(1)} g/日
・脂質：${avg.f.toFixed(1)} g/日
・炭水化物：${avg.c.toFixed(1)} g/日`;

  const goal = goalKcal
    ? formatGoalBlockFromKcal(goalKcal, avg.kcal, "🎯 1日目標（平均ベース）")
    : "";

  return base + goal;
}

function formatUndoMessage(date, count, total, rows) {
  const names = rows
    .map(r => r.food_name)
    .filter(Boolean)
    .slice(0, 3);
  const more = Math.max(0, count - names.length);

  return `🗑 直前の記録を取り消しました（${date}）

削除：${count} 件
${names.length ? "内容：" + names.join(" / ") + (more ? ` ほか${more}件` : "") : ""}

🔥 合計
約 ${Math.round(total.kcal)} kcal

🥗 PFC
・たんぱく質：${total.p.toFixed(1)} g
・脂質：${total.f.toFixed(1)} g
・炭水化物：${total.c.toFixed(1)} g`;
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
   コーチ（キャッシュでコスト削減）
================================ */
function getMaxCreatedAt(rows) {
  let max = null;
  for (const r of rows || []) {
    const c = r?.created_at ? new Date(r.created_at).toISOString() : null;
    if (!c) continue;
    if (!max || c > max) max = c;
  }
  return max; // ISO文字列 or null
}

// foods要約（短く = トークン削減）
function summarizeFoods(rows, max = 4) {
  const map = new Map();
  for (const r of rows || []) {
    const name = String(r.food_name || "").trim();
    if (!name) continue;
    const kcal = Number(r.calories ?? 0) || 0;
    map.set(name, (map.get(name) || 0) + kcal);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name, kcal]) => `${name}(${Math.round(kcal)}kcal)`)
    .join(" / ");
}

function makeInputHash(obj) {
  const s = JSON.stringify(obj);
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function getCoachCached({ userId, cacheKey, rows, scope, dateLabel, totalKcal, totalP, totalF, totalC, goalKcal }) {
  const baseLastCreatedAt = getMaxCreatedAt(rows);
  const foods = summarizeFoods(rows);

  const inputHash = makeInputHash({
    scope,
    dateLabel,
    kcal: Math.round(totalKcal),
    p: Number(totalP || 0).toFixed(1),
    f: Number(totalF || 0).toFixed(1),
    c: Number(totalC || 0).toFixed(1),
    goalKcal: goalKcal ? Math.round(goalKcal) : null,
    foods,
  });

  // ✅ キャッシュ参照
  const cached = await fetchCoachCache(userId, cacheKey);
  if (
    cached &&
    cached.input_hash === inputHash &&
    String(cached.base_last_created_at || "") === String(baseLastCreatedAt || "")
  ) {
    return cached.coach_text;
  }

  // ✅ 生成（失敗時はルールベース）
  const coachText = await buildCoachBlock({
    scope,
    dateLabel,
    totalKcal,
    totalP,
    totalF,
    totalC,
    goalKcal,
    foods,
  });

  if (coachText) {
    await upsertCoachCache(userId, cacheKey, baseLastCreatedAt, inputHash, coachText);
  }
  return coachText;
}

async function buildCoachBlock({ scope, dateLabel, totalKcal, totalP, totalF, totalC, goalKcal, foods }) {
  if (!Number.isFinite(totalKcal) || totalKcal <= 0) return "";

  const fallback = () => {
    const p = Number(totalP) || 0;
    const over = goalKcal ? totalKcal - goalKcal : 0;

    let balance = "概ねOK";
    if (goalKcal) {
      if (over > 200) balance = "摂取多め（調整余地あり）";
      else if (over < -300) balance = "摂取少なめ（不足気味）";
    }

    let next = "おにぎり＋サラダチキン＋野菜スープ（バランス型）";
    if (p < 60) next = "サラダチキン／ゆで卵／ギリシャヨーグルト（高たんぱく）";
    else if (over > 200) next = "具だくさんスープ／サラダ＋ノンオイル／豆腐（脂質控えめ）";

    let swap = "甘い飲み物→無糖に（-150〜200kcal目安）";
    if (over > 200) swap = "揚げ物→焼き/蒸し系に（-200kcal目安）";

    return `🤖 コーチ（目安）
・バランス：${balance}
・次の食事提案（コンビニ例）：${next}
・おすすめ置換：${swap}
※あくまで目安です`;
  };

  try {
    // ✅ できるだけ短いプロンプト = コスト削減
    const prompt = `
出力はJSONのみ。

ユーザーの摂取量から「バランス所感」「次の食事提案（コンビニで買えるカテゴリ名）」「おすすめ置換（-200kcal目安）」を作る。
ブランド名禁止。医療断定禁止。短く。

入力:
scope:${scope}
date:${dateLabel}
kcal:${Math.round(totalKcal)}
p:${Number(totalP||0).toFixed(1)}
f:${Number(totalF||0).toFixed(1)}
c:${Number(totalC||0).toFixed(1)}
goal:${goalKcal ? Math.round(goalKcal) : "null"}
foods:${foods || "なし"}

出力:
{
 "balance": "短い所感",
 "next_meal": ["提案1","提案2","提案3"],
 "swap": "置換案"
}
`.trim();

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: prompt,
        temperature: 0.3,
        text: { format: { type: "json_object" } },
      }),
    });

    const j = await r.json();
    const parsed = tryParseJson(extractText(j));
    if (!parsed) return fallback();

    const balance = String(parsed.balance || "").trim();
    const next = Array.isArray(parsed.next_meal) ? parsed.next_meal.map(x => String(x)).filter(Boolean) : [];
    const swap = String(parsed.swap || "").trim();

    if (!balance || !next.length || !swap) return fallback();

    return `🤖 コーチ（目安）
・バランス：${balance}
・次の食事提案（コンビニ例）：${next.slice(0, 3).join(" / ")}
・おすすめ置換：${swap}
※あくまで目安です`;
  } catch (e) {
    console.error("coach error:", e);
    return fallback();
  }
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
