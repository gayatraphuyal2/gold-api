// ====================== Imports ======================
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const fs = require("fs");
const cron = require("node-cron");

const app = express();
app.use(cors());

const path = require("path");
const { execSync } = require("child_process");



// ====================== OneSignal ======================
const ONESIGNAL_APP_ID = "d9aa22ce-13de-4b51-85d7-ee688465f7b6";
// Use REST API Key here
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY || "os_v2_app_3gvcftqt3zfvdbox5zuiizpxwzcibpsmomcubqecc74ulpfqebb6hhq53snyej6k4pcr7no4sorhn7sk22lpypcvfhkwineeoc543qa";
const ANDROID_CHANNEL_ID = "84217cf6-dfde-45db-97b8-74d5b2a9b749";

// ====================== Config ======================
const SOURCE_URL = "https://fenegosida.org/";
const CACHE_FILE = "./last_cache.json";

// ====================== Utils ======================
function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function parsePrice(text) {
  if (!text) return null;
  const n = Number(text.replace(/[^\d]/g, ""));
  return isNaN(n) ? null : n;
}

function buildResponse(data, status) {
  return {
    date: data.date,
    status, // "ok" | "cache"
    unit: "tola",
    rates: [
      { id: "gold", title: "छापावाल सुन", price: data.gold },
      { id: "silver", title: "चाँदी", price: data.silver }
    ]
  };
}


// ====================== Cache ======================
function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function saveCache(data) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
}


const DATA_DIR = "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function saveDateJSON(date, data) {
  const file = path.join(DATA_DIR, `${date}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(buildResponse(data, "ok"), null, 2)
  );
}

function pushToGit(date) {
  try {
    execSync(`git add data/${date}.json last_cache.json`);
    execSync(`git commit -m "Gold/Silver update ${date}"`);
    execSync("git push origin main");
    console.log("🚀 GitHub pushed:", date);
  } catch (e) {
    console.warn("⚠️ Git push skipped (no diff)");
  }
}





// ====================== Nepali Date ======================
const nepaliMonths = {
  Baishakh: "01", Jestha: "02", Ashadh: "03", Shrawan: "04",
  Bhadra: "05", Ashwin: "06", Kartik: "07", Mangsir: "08",
  Poush: "09", Magh: "10", Falgun: "11", Chaitra: "12"
};

function formatNepaliDate(dateStr) {
  const m = dateStr.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const day = m[1].padStart(2, "0");
  const month = nepaliMonths[m[2]];
  const year = m[3];
  if (!month) return null;
  return `${year}-${month}-${day}`;
}

// ====================== Notification ======================
async function sendNotification(title, message) {
  if (!ONESIGNAL_API_KEY) {
    console.warn("⚠️ OneSignal API key missing, skipping notification");
    return;
  }
  try {
    await axios.post(
      "https://onesignal.com/api/v1/notifications",
      {
        app_id: ONESIGNAL_APP_ID,
        included_segments: ["All"],
        android_channel_id: ANDROID_CHANNEL_ID,
        headings: { en: title },
        contents: { en: message }
      },
      {
        headers: {
          Authorization: `Basic ${ONESIGNAL_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    console.log("🔔 Notification sent");
  } catch (e) {
    console.error("❌ Notification error:", e.response?.data || e.message);
  }
}

// ====================== Scraper ======================
async function scrapeFenegosida() {
  try {
    const { data } = await axios.get(SOURCE_URL, {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120" }
    });

    const $ = cheerio.load(data);
    let gold = null, silver = null;

    $("*").each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ");
      if (!gold && /FINE GOLD/i.test(text)) {
        const m = text.match(/[₹रु]\s*([\d,]+)/);
        if (m) gold = parsePrice(m[1]);
      }
      if (!silver && /SILVER/i.test(text)) {
        const all = [...text.matchAll(/[₹रु]\s*([\d,]+)/g)];
        if (all.length) silver = parsePrice(all[all.length - 1][1]);
      }
    });

    if (!gold || !silver) throw new Error("Scraping failed");

    // Get site date
    let siteDate = null;
    const bodyText = $("body").text().replace(/\s+/g, " ");
    const d = bodyText.match(/\d{1,2}\s+[A-Za-z]+\s+\d{4}/);
    if (d) siteDate = formatNepaliDate(d[0]);

    return { date: siteDate || todayDate(), gold, silver };
  } catch (err) {
    console.warn("⚠️ Live fetch failed:", err.message);
    throw err; // IMPORTANT
  }
}

// ====================== API ======================
app.get("/prices", async (req, res) => {
  try {
    // 🟢 Try LIVE site
    const fresh = await scrapeFenegosida();
    const cache = loadCache();

    // Notify only if data changed (UNCHANGED)
    if (
      cache &&
      (cache.date !== fresh.date ||
        cache.gold !== fresh.gold ||
        cache.silver !== fresh.silver)
    ) {
      let msgs = [];
      if (cache.date !== fresh.date) msgs.push(`📅 नयाँ मिति: ${fresh.date}`);
      if (cache.gold !== fresh.gold) msgs.push(`🥇 सुन: रु ${fresh.gold}`);
      if (cache.silver !== fresh.silver) msgs.push(`🥈 चाँदी: रु ${fresh.silver}`);
      if (msgs.length)
        await sendNotification("आजको सुन–चाँदी अपडेट", msgs.join("\n"));
    }

    saveCache(fresh);

    // ✅ LIVE RESPONSE
    return res.json(buildResponse(fresh, "ok"));

  } catch (err) {
    // 🔴 SITE DOWN → CACHE
    const cached = loadCache();
    if (cached) {
      return res.json(buildResponse(cached, "cache"));
    }

    return res.status(503).json({
      status: "error",
      message: "Service unavailable"
    });
  }
});


// ====================== Test ======================
app.get("/test", (req, res) => {
  res.json({ status: "ok", message: "API running 🚀" });
});

// ====================== Cron Auto-Notification ======================
// ====================== Cron Auto-Notification ======================
cron.schedule("*/5 * * * *", async () => {
  try {
    const fresh = await scrapeFenegosida();
    const cache = loadCache();

    const changed =
      !cache ||
      cache.date !== fresh.date ||
      cache.gold !== fresh.gold ||
      cache.silver !== fresh.silver;

    // ✅ DATE OR PRICE CHANGE → JSON + GITHUB
    if (changed) {
      console.log("🔄 Change detected → saving & pushing");

      saveCache(fresh);
      saveDateJSON(fresh.date, fresh);
      pushToGit(fresh.date);
    }
  } catch (err) {
    console.warn("⚠️ Cron fetch failed:", err.message);
  }
});


// ====================== Start ======================
const PORT = 3003;
app.listen(PORT, () => console.log(`✅ Gold API running on port ${PORT}`));
