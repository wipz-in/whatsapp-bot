// broadcast.js
// One-off script to send the "wipz_mega_festive_sale" template to all retailers.
// Run with: node broadcast.js
//
// Requires the same env vars your bot already uses on Render:
//   PHONE_NUMBER_ID, ACCESS_TOKEN
// You can run this LOCALLY (export those two vars in your shell first)
// or as a one-off Render Shell command / Job — it does not need to run
// on the always-on web service.

const fs    = require("fs");
const axios = require("axios");

const PHONE_ID = process.env.PHONE_NUMBER_ID;
const TOKEN    = process.env.ACCESS_TOKEN;

const TEMPLATE_NAME = "retail_festive_sale";
const TEMPLATE_LANG = "mr";

const CSV_PATH   = "./retailers_clean.csv"; // phone,shop,city
const BATCH_SIZE = 40;     // messages per batch
const BATCH_DELAY_MS = 5000; // pause between batches (5s)
const PER_MSG_DELAY_MS = 250; // small stagger within a batch

const BANNER_IMAGE_URL = "https://res.cloudinary.com/dz6fzuzvr/image/upload/v1788728091/ChatGPT_Image_Sep_1_2026_11_32_48_AM_z9gdma.png";

const LOG_SUCCESS = "./broadcast_success.log";
const LOG_FAILED  = "./broadcast_failed.log";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadRetailers() {
  const raw = fs.readFileSync(CSV_PATH, "utf8").trim().split("\n");
  const rows = raw.slice(1); // skip header
  return rows.map(line => {
    const [phone, shop, city] = line.split(",");
    return { phone: (phone || "").trim(), shop: (shop || "").trim(), city: (city || "").trim() };
  }).filter(r => /^\d{12}$/.test(r.phone)); // 91 + 10 digits
}

// If your template has NO variables in the body, leave components as [].
// If it does (e.g. {{1}} for shop name), uncomment and adjust below.
function buildComponents(retailer) {
  return [
    {
      type: "header",
      parameters: [
        { type: "image", image: { link: BANNER_IMAGE_URL } }
      ]
    }
  ];
  // If the body also has a variable (e.g. {{1}} for shop name), add a
  // second component here:
  // {
  //   type: "body",
  //   parameters: [
  //     { type: "text", text: retailer.shop || "Retailer" }
  //   ]
  // }
}

async function sendTemplate(retailer) {
  const payload = {
    messaging_product: "whatsapp",
    to: retailer.phone,
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG },
      components: buildComponents(retailer)
    }
  };

  try {
    const res = await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
    const msgId = res.data && res.data.messages && res.data.messages[0] && res.data.messages[0].id;
    fs.appendFileSync(LOG_SUCCESS, `${retailer.phone},${retailer.shop},${msgId}\n`);
    return true;
  } catch (err) {
    const errData = err.response ? JSON.stringify(err.response.data) : err.message;
    fs.appendFileSync(LOG_FAILED, `${retailer.phone},${retailer.shop},${errData}\n`);
    console.error("FAILED:", retailer.phone, errData);
    return false;
  }
}

async function main() {
  if (!PHONE_ID || !TOKEN) {
    console.error("Missing PHONE_NUMBER_ID or ACCESS_TOKEN env vars. Aborting.");
    process.exit(1);
  }

  const retailers = loadRetailers();
  console.log(`Loaded ${retailers.length} retailers. Starting broadcast...`);

  let sent = 0, failed = 0;

  for (let i = 0; i < retailers.length; i += BATCH_SIZE) {
    const batch = retailers.slice(i, i + BATCH_SIZE);
    console.log(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1} — sending ${batch.length} messages...`);

    for (const retailer of batch) {
      const ok = await sendTemplate(retailer);
      if (ok) sent++; else failed++;
      await sleep(PER_MSG_DELAY_MS);
    }

    console.log(`Progress: ${sent} sent, ${failed} failed, ${retailers.length - sent - failed} remaining`);

    if (i + BATCH_SIZE < retailers.length) {
      console.log(`Pausing ${BATCH_DELAY_MS / 1000}s before next batch...`);
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(`\nDone. Sent: ${sent}, Failed: ${failed}. See ${LOG_SUCCESS} / ${LOG_FAILED} for details.`);
}

main();
