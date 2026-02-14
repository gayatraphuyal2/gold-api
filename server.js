// ====================== Imports ======================
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const fs = require("fs");
const cron = require("node-cron");
const { exec } = require("child_process");

const app = express();
app.use(cors());



// ====================== Config ======================
const SOURCE_URL = "https://fenegosida.org/";
const CACHE_FILE = "./last_success.json";

// ====================== Utils ======================
function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function parsePrice(text) {
  if (!text) return null;
  const n = Number(text.replace(/[^\d]/g, ""));
  return isNaN(n) ? null : n;
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
  const filePath = CACHE_FILE;
  const newData = JSON.stringify(data, null, 2);

  let oldData = null;
  if (fs.existsSync(filePath)) oldData = fs.readFileSync(filePath, "utf8");

  // Save & push only if changed
  if (oldData !== newData) {
    fs.writeFileSync(filePath, newData);

    // Optional: push to GitHub
    exec(`
      git add last_success.json &&
      git commit -m "Auto update gold price" &&
      git push
    `, (error, stdout, stderr) => {
      if (error) console.error("Git push error:", error.message);
      else console.log("✅ GitHub auto-updated");
    });

    console.log("✅ Cache updated:", data.date);
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


function isWithinUpdateTime() {
  const now = new Date();

  // Nepal time (Asia/Kathmandu)
  const local = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kathmandu" })
  );

  const hours = local.getHours();
  const minutes = local.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  const start = 10 * 60 + 13; // 10:13 AM
  const end = 13 * 60;        // 1:00 PM

  return totalMinutes >= start && totalMinutes <= end;
}

async function autoUpdate() {
  try {
    if (!isWithinUpdateTime()) {
      return; // ⛔ outside allowed time
    }

    const externalData = await scrapeFenegosida();
    if (!externalData) return;

    const cached = loadCache();

    if (
      !cached ||
      cached.date !== externalData.date ||
      cached.rates[0].price !== externalData.gold ||
      cached.rates[1].price !== externalData.silver
    ) {
      const newCache = {
        date: externalData.date,
        status: "ok",
        unit: "tola",
        rates: [
          { id: "gold", title: "छापावाल सुन", price: externalData.gold },
          { id: "silver", title: "चाँदी", price: externalData.silver }
        ]
      };

      saveCache(newCache);
      console.log("✅ Updated during allowed time");
    }

  } catch (err) {
    console.warn("⚠️ Auto-update error:", err.message);
  }
}

// Run every 5 minutes
setInterval(autoUpdate, 5 * 60 * 1000);


// ====================== API ======================
app.get("/prices", (req, res) => {
  const cached = loadCache();
  if (cached) return res.json(cached);

  return res.status(503).json({
    status: "error",
    message: "Service unavailable"
  });
});

// ====================== Start Server ======================
const PORT = 3003;
app.listen(PORT, () => console.log(`✅ Gold API running on port ${PORT}`));