// ====================== Imports ======================
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const { exec } = require("child_process");

const app = express();
app.use(cors());

// ====================== Config ======================
const SOURCE_URL = "https://calendar-event.pages.dev/data/gold.json";
const CACHE_FILE = "./last_success.json";

// ====================== Utils ======================
function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

// ====================== Cache Helpers ======================
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

// ====================== Fetch External JSON ======================
async function fetchExternal() {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });

    if (!data || !Array.isArray(data.rates)) throw new Error("Invalid JSON");

    const gold = data.rates.find(r => r.id === "gold")?.price ?? 0;
    const silver = data.rates.find(r => r.id === "silver")?.price ?? 0;

    return {
      date: data.date || todayDate(),
      gold,
      silver
    };
  } catch (err) {
    console.error("⚠️ Fetch error:", err.message);
    return null;
  }
}

// ====================== Auto Update Loop ======================
// ====================== Auto Update Loop ======================
async function autoUpdate() {
  try {
    const externalData = await fetchExternal();
    if (!externalData) return;

    const cached = loadCache();

    // Compare date & price
    if (
      !cached ||
      cached.date !== externalData.date ||
      cached.rates[0].price !== externalData.gold ||
      cached.rates[1].price !== externalData.silver
    ) {
      // Update local cache
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
    }
  } catch (err) {
    console.warn("⚠️ Auto-update error:", err.message);
  }
}

// Run every 60 seconds (1 minute)
setInterval(autoUpdate, 60 * 1000);


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
