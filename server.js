// ====================== Imports ======================
const express = require("express");
const axios = require("axios");

const cors = require("cors");
const fs = require("fs");
const cron = require("node-cron");
require("dotenv").config();
const app = express();
app.use(cors());

// ====================== Config ======================
const SOURCE_URL = "https://calendar-event.pages.dev/data/gold.json";
const HISTORY_FILE = "./history.json";
const CACHE_FILE = "./last_success.json";

const NOTIFY_CACHE = "./last_notified.json";
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const ANDROID_CHANNEL_ID = process.env.ANDROID_CHANNEL_ID;


function loadNotifyCache() {
  if (!fs.existsSync(NOTIFY_CACHE)) return null;
  return JSON.parse(fs.readFileSync(NOTIFY_CACHE, "utf8"));
}

function saveNotifyCache(data) {
  fs.writeFileSync(NOTIFY_CACHE, JSON.stringify(data, null, 2));
}

// ====================== Utils ======================
function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function parsePrice(text) {
  if (!text) return null;
  const n = Number(text.replace(/[^\d]/g, ""));
  return isNaN(n) ? null : n;
}

// ====================== File Helpers ======================
function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) {
    return { unit: "tola", data: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch {
    return { unit: "tola", data: [] };
  }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

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

// ====================== 🔥 CORE LOGIC ======================

// ✅ Find last DIFFERENT price (real market logic)
function getLastDifferent(history, key, currentValue) {
  for (let i = history.data.length - 1; i >= 0; i--) {
    const v = history.data[i][key];
    if (v != null && v !== currentValue) {
      return v;
    }
  }
  return null;
}

// ✅ Calculate change (never resets direction incorrectly)
function calculateChange(current, previous, lastDirection = "same") {
  if (previous == null) {
    return { change: 0, percent: 0, direction: "same" };
  }

  const diff = current - previous;

  if (diff === 0) {
    return { change: 0, percent: 0, direction: lastDirection };
  }

  const direction = diff > 0 ? "up" : "down";
  const percent = previous === 0 ? 0 : (Math.abs(diff) / previous) * 100;

  return {
    change: Math.abs(diff),
    percent: Number(percent.toFixed(2)),
    direction
  };
}

const nepaliMonths = {
  Baishakh: "01", Jestha: "02", Ashadh: "03", Shrawan: "04",
  Bhadra: "05", Ashwin: "06", Kartik: "07", Mangsir: "08",
  Poush: "09", Magh: "10", Falgun: "11", Chaitra: "12"
};

function formatNepaliDate(dateStr) {
  const match = dateStr.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!match) return null;
  const day = match[1].padStart(2, "0");
  const month = nepaliMonths[match[2]];
  const year = match[3];
  if (!month) return null;
  return `${year}-${month}-${day}`;
}

async function sendNotification(title, message) {
  try {
    await axios.post(
      "https://onesignal.com/api/v1/notifications",
      {
        app_id: ONESIGNAL_APP_ID,
        included_segments: ["All"],
        android_channel_id: ANDROID_CHANNEL_ID,

        headings: { en: title },
        contents: { en: message },

        // 🔥 CLICK DATA (THIS FIXES IT)
        data: {
          type: "gold"
        },

        priority: 10,
        android_visibility: 1,
        android_sound: "default",
        ttl: 60
      },
      {
        headers: {
          Authorization: `Basic ${ONESIGNAL_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("🔔 Notification sent");
  } catch (e) {
    console.error("❌ Notification failed", e.response?.data || e.message);
  }
}

// ====================== Scraper ======================
async function scrapeFenegosida() {
  const { data } = await axios.get(SOURCE_URL, {
    timeout: 15000
  });

  if (!data || !Array.isArray(data.rates)) {
    throw new Error("Invalid JSON structure");
  }

  const gold = data.rates.find(r => r.id === "gold")?.price ?? null;
  const silver = data.rates.find(r => r.id === "silver")?.price ?? null;

  if (!gold || !silver) {
    throw new Error("Gold/Silver price missing");
  }

  return {
    date: data.date || todayDate(), // BS date from source
    gold,
    silver
  };
}


// ====================== API ======================
app.get("/prices", async (req, res) => {
  try {
    const scraped = await scrapeFenegosida();
    const history = loadHistory();

    const last = history.data[history.data.length - 1];

    // 🔥 REAL previous price (last different)
    const prevGold = getLastDifferent(history, "gold", scraped.gold);
    const prevSilver = getLastDifferent(history, "silver", scraped.silver);

    const lastGoldDir = last?.goldDirection ?? "same";
    const lastSilverDir = last?.silverDirection ?? "same";

    const goldChange = calculateChange(scraped.gold, prevGold, lastGoldDir);
    const silverChange = calculateChange(scraped.silver, prevSilver, lastSilverDir);

    // ✅ Save history ONLY when price or date changes
    const existsSameDate = history.data.some(item => item.date === scraped.date);

    // ✅ save only when:
    // - new BS date OR
    // - price changed
    if (!existsSameDate || last.gold !== scraped.gold || last.silver !== scraped.silver) {

      // remove old same-date record (avoid duplicate)
      history.data = history.data.filter(item => item.date !== scraped.date);

      history.data.push({
        date: scraped.date,
        gold: scraped.gold,
        silver: scraped.silver,
        goldDirection: goldChange.direction,
        silverDirection: silverChange.direction
      });

      if (history.data.length > 60) {
        history.data = history.data.slice(-60);
      }

      saveHistory(history);
    }


    const response = {
      source: "calendar-event.pages.dev",
      status: "live",
      date: scraped.date,
      unit: "tola",
      rates: [
        {
          id: "gold",
          title: "छापावाल सुन",
          price: scraped.gold,
          previous: prevGold,
          ...goldChange
        },
        {
          id: "silver",
          title: "चाँदी",
          price: scraped.silver,
          previous: prevSilver,
          ...silverChange
        }
      ]
    };

    saveCache(response);
    return res.json(response);

  } catch (err) {
    console.warn("⚠️ Live fetch failed, using cache");

    const cached = loadCache();
    if (cached) {
      cached.status = "cached";
      cached.message = "Live server down, showing last update";
      return res.json(cached);
    }

    return res.status(503).json({
      status: "error",
      message: "Service unavailable"
    });
  }
});

// ====================== History APIs ======================
app.get("/market/history/7", (req, res) => {
  const history = loadHistory();
  res.json({ unit: history.unit, days: 7, data: history.data.slice(-7) });
});

app.get("/market/history/30", (req, res) => {
  const history = loadHistory();
  res.json({ unit: history.unit, days: 30, data: history.data.slice(-30) });
});


async function checkAndNotify(scraped) {
  const lastNotified = loadNotifyCache();

  let messages = [];

  if (!lastNotified || lastNotified.date !== scraped.date) {
    messages.push(`📅 मिति: ${scraped.date}`);
  }

  if (!lastNotified || lastNotified.gold !== scraped.gold) {
    const dir = lastNotified && scraped.gold > lastNotified.gold ? "💹 बढ्यो" : "📉 घट्यो";
    messages.push(`🥇 सुन ${dir}: रु ${scraped.gold}`);
  }

  if (!lastNotified || lastNotified.silver !== scraped.silver) {
    const dir = lastNotified && scraped.silver > lastNotified.silver ? "💹 बढ्यो" : "📉 घट्यो";
    messages.push(`🥈 चाँदी ${dir}: रु ${scraped.silver}`);
  }

  if (messages.length > 0) {
    await sendNotification(
      "आजको सुन–चाँदी अपडेट",
      messages.join("\n")
    );

    saveNotifyCache({
      date: scraped.date,
      gold: scraped.gold,
      silver: scraped.silver
    });

    console.log("🔔 Auto notification sent");
  }
}

cron.schedule("* * * * *", async () => {
  try {
    const scraped = await scrapeFenegosida();
    await checkAndNotify(scraped);
  } catch (e) {
    console.error("❌ Notify cron error:", e.message);
  }
}, { timezone: "Asia/Kathmandu" });



// ====================== Cron Job (Daily Save) ======================
cron.schedule("5 10 * * *", async () => {
  try {
    const scraped = await scrapeFenegosida();
    const history = loadHistory();
    const last = history.data[history.data.length - 1];

    const exists = history.data.some(item => item.date === scraped.date);

    if (!exists) {
      history.data.push({
        date: scraped.date,
        gold: scraped.gold,
        silver: scraped.silver,
        goldDirection: "same",
        silverDirection: "same"
      });
      saveHistory(history);
      console.log("📊 Daily history saved");
    }
  } catch (e) {
    console.error("❌ Cron error:", e.message);
  }
}, { timezone: "Asia/Kathmandu" });

// ====================== Start Server ======================
const PORT = 3003;
app.listen(PORT, () => console.log(`✅ Gold API running on port ${PORT}`));
