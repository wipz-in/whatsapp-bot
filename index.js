const express    = require("express");
const bodyParser = require("body-parser");
const axios      = require("axios");
const crypto     = require("crypto");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const { google } = require("googleapis");
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const SHEET_ID = "1eC8M6-9OpGlZ0G9r64i__sWoSW3o0hzxUp97Po4bJSk";

const app = express();

// ⚠️ Raw body parser for /flow-endpoint (needed for decryption)
// Must come BEFORE bodyParser.json()
app.use((req, res, next) => {
  if (req.path === "/flow-endpoint") {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      req.rawBody = raw;
      try { req.body = JSON.parse(raw); } catch { req.body = {}; }
      next();
    });
  } else {
    bodyParser.json()(req, res, next);
  }
});

// =========================
// 🔐 CONFIG
// =========================
const VERIFY_TOKEN        = "my_verify_token";
const PHONE_ID            = process.env.PHONE_NUMBER_ID;
const TOKEN               = process.env.ACCESS_TOKEN;
const UPI_VPA             = process.env.UPI_VPA             || "9657748074-3@ibl";
const UPI_NAME            = process.env.UPI_NAME            || "Wipz";
const PAYMENT_CONFIG_NAME = "whatsapp_orders";
const ADDRESS_FLOW_ID     = process.env.ADDRESS_FLOW_ID     || "YOUR_FLOW_ID_HERE";
const FLOW_PRIVATE_KEY    = process.env.FLOW_PRIVATE_KEY    || "";

// start_message template image URL
// Get it from: WhatsApp Manager → Templates → start_message → right-click image → Copy image address
const START_MESSAGE_IMAGE_URL = process.env.START_MESSAGE_IMAGE_URL || "YOUR_IMAGE_URL_HERE";

// 🧠 In-memory state
const userState  = {};
const userOrders = {};


// =========================
// ✅ WEBHOOK VERIFY
// =========================
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});


// =========================
// 🔓 FLOW ENDPOINT
// Meta calls this URL when the address Flow needs to exchange data.
// Set this URL in your Flow JSON: "data_channel_uri": "https://your-app.onrender.com/flow-endpoint"
// =========================
app.post("/flow-endpoint", async (req, res) => {
  try {
    console.log("📋 Flow endpoint raw body:", req.rawBody);

    const body = req.body;

    // ── Health check ping from Meta ──────────────────────────────────────
    if (body?.action === "ping") {
      console.log("✅ Flow health check ping received");
      return res.json({ data: { status: "active" } });
    }

    // ── Decrypt if payload is encrypted ─────────────────────────────────
    let decrypted;
    if (body.encrypted_aes_key && body.encrypted_flow_data) {
      try {
        decrypted = decryptFlowPayload(body);
        console.log("🔓 Decrypted flow data:", JSON.stringify(decrypted, null, 2));
      } catch (err) {
        console.error("❌ Flow decryption failed:", err.message);
        return res.status(421).json({ error: "Decryption failed" });
      }
    } else {
      // Not encrypted (e.g. during testing / draft mode)
      decrypted = body;
    }

    const { action, screen, data, flow_token, version } = decrypted;

    // ── Extract phone from flow_token ────────────────────────────────────
    // We set flow_token as "ADDR_<phone>_<timestamp>" when sending the flow
    const phone = (flow_token || "").split("_")[1] || null;
    console.log("📱 Flow phone:", phone, "| action:", action, "| screen:", screen);

    // ── INIT action — return first screen data if needed ────────────────
    if (action === "INIT") {
      return res.json({
        screen: "ADDRESS_SCREEN",
        data: {}
      });
    }

    // ── DATA_EXCHANGE — return next screen ──────────────────────────────
    if (action === "data_exchange") {
      return res.json({
        screen: "SUCCESS",
        data: { extension_message_response: { params: { flow_token } } }
      });
    }

    // Default
    return res.json({ data: { status: "ok" } });

  } catch (err) {
    console.error("Flow endpoint error:", err.message);
    return res.status(500).json({ error: "Internal error" });
  }
});


// =========================
// 🔐 DECRYPT FLOW PAYLOAD (AES-128-GCM + RSA-OAEP)
// =========================
function decryptFlowPayload(body) {
  if (!FLOW_PRIVATE_KEY) throw new Error("FLOW_PRIVATE_KEY env not set");

  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;

  // Step 1: Decrypt AES key using RSA private key (OAEP + SHA-256)
  const decryptedAesKey = crypto.privateDecrypt(
    {
      key:     FLOW_PRIVATE_KEY,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(encrypted_aes_key, "base64")
  );

  // Step 2: Decrypt flow data using AES-128-GCM
  const iv            = Buffer.from(initial_vector, "base64");
  const encryptedBuf  = Buffer.from(encrypted_flow_data, "base64");
  const TAG_LEN       = 16;
  const cipherText    = encryptedBuf.slice(0, -TAG_LEN);
  const authTag       = encryptedBuf.slice(-TAG_LEN);

  const decipher = crypto.createDecipheriv("aes-128-gcm", decryptedAesKey, iv);
  decipher.setAuthTag(authTag);

  const decryptedStr = decipher.update(cipherText, undefined, "utf8") + decipher.final("utf8");
  return JSON.parse(decryptedStr);
}


// =========================
// 📝 SAVE CHAT LOG
// =========================
async function saveChatLog(data) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Logs!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[
        new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        data.phone, data.message, data.step
      ]]}
    });
  } catch (err) { console.error("Chat log error:", err.message); }
}


// =========================
// 🎬 SEND WELCOME TEMPLATES
// =========================
async function sendWelcomeTemplates(to) {

  // ── Template 1: start_message (image header) ────────────────────────
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: "start_message",
          language: { code: "en" },
          components: [
            {
              type: "header",
              parameters: [{ type: "image", image: { link: START_MESSAGE_IMAGE_URL } }]
            }
          ]
        }
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("✅ start_message sent");
  } catch (err) {
    console.error("start_message error:", JSON.stringify(err.response?.data, null, 2));
  }

  await new Promise(r => setTimeout(r, 1200));

  // ── Template 2: intro_catalog (catalog button) ───────────────────────
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: "intro_catalog",
          language: { code: "en" },
          components: [
            {
              type: "button",
              sub_type: "CATALOG",
              index: "0",
              parameters: [
                {
                  type: "action",
                  action: { thumbnail_product_retailer_id: "" }
                }
              ]
            }
          ]
        }
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("✅ intro_catalog sent");
  } catch (err) {
    console.error("intro_catalog error:", JSON.stringify(err.response?.data, null, 2));
  }
}


// =========================
// 📋 SEND ADDRESS FLOW
// =========================
async function sendAddressFlow(to) {
  try {
    const flowToken = `ADDR_${to}_${Date.now()}`;  // phone embedded in token

    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "interactive",
        interactive: {
          type: "flow",
          header: { type: "text", text: "📦 Delivery Details" },
          body: { text: "Please fill in your delivery address so we can ship your order 🚚" },
          footer: { text: "Wipz — Fast & Secure Delivery 💖" },
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              flow_token: flowToken,
              flow_id: ADDRESS_FLOW_ID,
              flow_cta: "Enter Delivery Address",
              flow_action: "navigate",
              flow_action_payload: { screen: "ADDRESS_SCREEN" }
            }
          }
        }
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("✅ Address flow sent to", to);
  } catch (err) {
    console.error("Address flow error:", JSON.stringify(err.response?.data, null, 2));
    // Fallback: ask for text address if flow fails
    await sendMessage(to,
      "📦 Please send your delivery details:\n\nName:\nAddress:\nCity:\nPincode:"
    );
  }
}


// =========================
// 💳 SEND PAYMENT MESSAGE
// =========================
async function sendUpiPaymentMessage(to, orderDetails) {
  const { totalPrice, lineItems, itemsSummary, orderId } = orderDetails;
  const amountInPaise = Math.round(totalPrice * 100);

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "order_details",
      body: {
        text: `Here's your order summary 🛍️\n\n${itemsSummary}\n\nTap *Review & Pay* to complete payment via UPI ✅`
      },
      footer: { text: "Wipz — Loved by 1000+ customers 💖" },
      action: {
        name: "review_and_pay",
        parameters: {
          reference_id: orderId,
          type: "digital-goods",
          payment_type: "upi",
          payment_configuration: PAYMENT_CONFIG_NAME,
          currency: "INR",
          total_amount: { value: amountInPaise, offset: 100 },
          order: {
            status: "pending",
            items: lineItems,
            subtotal: { value: amountInPaise, offset: 100 },
            tax:      { value: 0, offset: 100, description: "GST Inclusive" },
            shipping: { value: 0, offset: 100, description: "Free Delivery" },
            discount: { value: 0, offset: 100, description: "" }
          }
        }
      }
    }
  };

  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("✅ Payment message sent");
    return { success: true };
  } catch (error) {
    console.error("❌ Payment failed:", JSON.stringify(error.response?.data, null, 2));
    return { success: false, error: error.response?.data };
  }
}


// =========================
// 🛒 BUILD ORDER SUMMARY
// =========================
function buildOrderSummary(items) {
  let totalPrice = 0;
  const lineItems = [];
  const lines = [];

  for (const item of items) {
    const lineTotal = item.price * item.quantity;
    totalPrice += lineTotal;
    lineItems.push({
      retailer_id: String(item.retailer_id),
      name: item.name,
      amount: { value: Math.round(item.price * 100), offset: 100 },
      quantity: item.quantity
    });
    lines.push(`• *${item.name}*  ×${item.quantity}  — ₹${lineTotal}`);
  }

  return {
    totalPrice,
    lineItems,
    itemsSummary: lines.join("\n") + `\n\n💰 *Total: ₹${totalPrice}*`
  };
}


// =========================
// 🚀 MAIN WEBHOOK
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    const incomingMsg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    // ── PAYMENT STATUS ─────────────────────────────────────────────────
    if (incomingMsg?.type === "interactive" &&
        incomingMsg?.interactive?.type === "payment_info") {

      const from        = incomingMsg.from;
      const paymentInfo = incomingMsg.interactive.payment_info;
      const status      = paymentInfo?.payment_status;
      const referenceId = paymentInfo?.reference_id;
      const txnId       = paymentInfo?.transaction_id;
      const amount      = (paymentInfo?.total_amount?.value || 0) / 100;

      console.log(`💰 Payment [${status}] Order:${referenceId} TXN:${txnId}`);

      if (status === "captured") {
        const productSummary = (userOrders[from]?.items || [])
          .map(i => `${i.name} ×${i.quantity}`).join(", ");

        await saveOrder({
          orderId:    referenceId,
          phone:      from,
          product:    productSummary,
          price:      amount,
          address:    userOrders[from]?.address || "",
          status:     "PAID ✅",
          screenshot: `UPI TXN: ${txnId}`,
          raw:        JSON.stringify(paymentInfo)
        });

        userState[from] = { step: "done", seenWelcome: true };

        await sendMessage(from,
          `✅ *Payment Confirmed!*\n\n🧾 Order ID: *${referenceId}*\n💰 Amount: ₹${amount}\n🔖 UTR: ${txnId}\n\nYour order is being processed 🚚\n\n💖 Thank you for shopping with *Wipz*!`
        );
        await sendOrderStatusUpdate(from, referenceId, "processing");

      } else if (status === "failed") {
        await sendMessage(from, `❌ Payment failed. Please try again 👇`);
        if (userOrders[from]) {
          const summary = buildOrderSummary(userOrders[from].items || []);
          await sendUpiPaymentMessage(from, { ...summary, orderId: referenceId });
        }
      }
      return res.sendStatus(200);
    }

    // ── FLOW COMPLETION (address form submitted) ────────────────────────
    // When customer submits the Flow, Meta sends nfm_reply to this webhook
    if (incomingMsg?.type === "interactive" &&
        incomingMsg?.interactive?.type === "nfm_reply") {

      const from         = incomingMsg.from;
      const nfmReply     = incomingMsg.interactive.nfm_reply;
      console.log("📋 Flow nfm_reply:", JSON.stringify(nfmReply, null, 2));

      // Parse submitted form data
      let formData = {};
      try {
        formData = JSON.parse(nfmReply.response_json || "{}");
      } catch {
        formData = nfmReply || {};
      }

      console.log("📦 Form data from Flow:", JSON.stringify(formData, null, 2));

      // ✅ Map Flow field IDs to address parts
      // These key names must match what you named your fields in Flow Builder
      // Common patterns — we try all of them so it works regardless of naming:
      const full_name      = formData.full_name      || "";
const phone_         = formData.phone          || "";
const address_line_1 = formData.address_line_1 || "";
const address_line_2 = formData.address_line_2 || "";
const address_line_3 = formData.address_line_3 || "";
const city           = formData.city           || "";
const pincode        = formData.pincode        || "";

const fullAddress = [
  full_name,
  phone_ ? `Ph: ${phone_}` : "",
  address_line_1,
  address_line_2,
  address_line_3,
  city,
  pincode
].filter(Boolean).join(", ");

      console.log("✅ Parsed address:", fullAddress);

      if (!userOrders[from]) {
        userOrders[from] = { items: [] };
      }
      userOrders[from].address = fullAddress;
      userOrders[from].status  = "address_received";

      if (!userOrders[from].items || userOrders[from].items.length === 0) {
        await sendMessage(from, "👉 Please select a product from catalogue first 🛍️");
        return res.sendStatus(200);
      }

      // Generate Order ID
      const now     = new Date();
      const orderId =
        "ORD" +
        now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }).replace(/\//g, "") +
        "-" + now.getTime().toString().slice(-5);

      userOrders[from].orderId = orderId;
      userState[from].step     = "payment";

      const summary = buildOrderSummary(userOrders[from].items);

      await sendMessage(from, "🎉 Almost there! Here's your order summary 👇");

      const result = await sendUpiPaymentMessage(from, { ...summary, orderId });

      if (!result.success) {
        await sendMessage(from,
          `💳 UPI ID: *${UPI_VPA}*\nAmount: *₹${summary.totalPrice}*\n\nPay and send screenshot 📸`
        );
      }

      return res.sendStatus(200);
    }

    // ── Normal messages ────────────────────────────────────────────────
    const message = incomingMsg;
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const type = message.type;

    if (!userState[from]) userState[from] = { step: "idle", seenWelcome: false };

    // Log
    let logMessage = message.text?.body || type;
    if (type === "order") {
      logMessage = (message.order?.product_items || [])
        .map(p => `${p.product_retailer_id} x${p.quantity}`).join(", ") || "Order";
    }
    await saveChatLog({ phone: from, message: logMessage, step: userState[from]?.step });
    console.log("Incoming:", JSON.stringify(message, null, 2));

    // ── FIRST-TIME VISITOR ─────────────────────────────────────────────
    if (!userState[from].seenWelcome) {
      userState[from].seenWelcome = true;
      userState[from].step        = "idle";
      await sendWelcomeTemplates(from);
      if (type !== "order") return res.sendStatus(200);
    }

    // ── ORDER FROM CATALOG ─────────────────────────────────────────────
    if (type === "order") {
      const products = message.order?.product_items || [];
      if (products.length === 0) return res.sendStatus(200);

      // Init or reset cart
      if (!userOrders[from] || userState[from].step === "done") {
        userOrders[from] = { items: [], status: "product_selected" };
        userState[from].step = "idle";
      }

      // Merge products into cart
      for (const p of products) {
        const existing = userOrders[from].items.find(
          i => i.retailer_id === p.product_retailer_id
        );
        if (existing) {
          existing.quantity += (p.quantity || 1);
        } else {
          userOrders[from].items.push({
            retailer_id: p.product_retailer_id,
            name:        p.product_retailer_id,
            price:       p.item_price  || 0,
            quantity:    p.quantity    || 1,
            imageUrl:    p.image?.link || null
          });
        }
      }

      const allItems  = userOrders[from].items;
      const cartTotal = allItems.reduce((s, i) => s + i.price * i.quantity, 0);

      // Send cart image
      const firstWithImage = allItems.find(i => i.imageUrl);
      if (firstWithImage) {
        await axios.post(
          `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to: from,
            type: "image",
            image: {
              link: firstWithImage.imageUrl,
              caption: allItems
                .map(i => `🛍️ *${i.name}*  |  Qty: ${i.quantity}  |  ₹${i.price * i.quantity}`)
                .join("\n")
            }
          },
          { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
        );
      }

      // Show cart summary
      const cartLines = allItems
        .map(i => `• *${i.name}*  ×${i.quantity}  — ₹${i.price * i.quantity}`)
        .join("\n");

      await sendMessage(from,
        `🛒 *Your Cart:*\n\n${cartLines}\n\n💰 *Total: ₹${cartTotal}*`
      );

      // ✅ Send address Flow form
      userState[from].step = "awaiting_address_flow";
      await sendAddressFlow(from);

      return res.sendStatus(200);
    }

    // ── TEXT FALLBACK ──────────────────────────────────────────────────
    if (type === "text") {
      const text = message.text.body.toLowerCase().trim();

      if (["hi", "hello", "start", "hey"].includes(text)) {
        userState[from]  = { step: "idle", seenWelcome: true };
        userOrders[from] = null;
        await sendMessage(from,
          "👋 Welcome back to *Wipz*! 💫\n\n😍 Browse our catalogue and pick your favourite pair 👟\n\n_(Tap the catalogue button to shop)_"
        );

      } else if (userState[from]?.step === "payment") {
        await sendMessage(from, "💳 Please tap *Review & Pay* above to complete your payment 👆");

      } else if (userState[from]?.step === "awaiting_address_flow") {
        await sendMessage(from, "📋 Please fill in the delivery form above 👆");

      } else {
        await sendMessage(from, "👉 Please select a product from catalogue to continue 🛍️");
      }
      return res.sendStatus(200);
    }

    // ── SCREENSHOT FALLBACK ────────────────────────────────────────────
    if (type === "image" && userState[from]?.step === "payment") {
      const imageUrl = await getMediaUrl(message.image.id);
      userOrders[from].status = "payment_screenshot_sent";
      userState[from].step    = "done";

      const orderId        = userOrders[from].orderId || "ORD-MANUAL";
      const productSummary = (userOrders[from].items || [])
        .map(i => `${i.name} ×${i.quantity}`).join(", ");
      const totalPrice = (userOrders[from].items || [])
        .reduce((s, i) => s + i.price * i.quantity, 0);

      await saveOrder({
        orderId, phone: from,
        product:    productSummary,
        price:      totalPrice,
        address:    userOrders[from].address || "",
        status:     "Screenshot received ⚠️",
        screenshot: imageUrl,
        raw:        JSON.stringify(userOrders[from])
      });

      await sendMessage(from,
        `✅ Screenshot received!\n\n🧾 Order ID: ${orderId}\n\nWe'll verify and process your order shortly 🚚\n\n💖 Thank you for shopping with Wipz!`
      );
      return res.sendStatus(200);
    }

    res.sendStatus(200);

  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});


// =========================
// 📦 ORDER STATUS UPDATE
// =========================
async function sendOrderStatusUpdate(to, referenceId, status) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "order_status",
          body: {
            text: status === "processing"
              ? "✅ Payment received! Your order is being processed."
              : `📦 Order status: ${status}`
          },
          action: {
            name: "shipment_update",
            parameters: { reference_id: referenceId, order_status: status }
          }
        }
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Order status error:", err.response?.data || err.message);
  }
}

async function getMediaUrl(mediaId) {
  try {
    const r1 = await axios.get(`https://graph.facebook.com/v25.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } });
    const r2 = await axios.get(r1.data.url,
      { headers: { Authorization: `Bearer ${TOKEN}` }, responseType: "arraybuffer" });
    return await uploadToCloudinary(r2.data);
  } catch (e) {
    console.error("Media error:", e.response?.data || e.message);
    return null;
  }
}

async function uploadToCloudinary(buf) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream({ folder: "whatsapp_orders" },
      (err, result) => err ? reject(err) : resolve(result.secure_url)
    ).end(buf);
  });
}

async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Send error:", e.response?.data || e.message);
  }
}

// ✅ saveOrder — address column is column F (index 5)
async function saveOrder(data) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[
        data.orderId    || "",
        new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        data.phone      || "",
        data.product    || "",
        data.price      || "",
        data.address    || "",   // ✅ Address from Flow saved here
        data.status     || "",
        data.screenshot || "",
        data.raw        || ""
      ]]}
    });
    console.log("✅ Order saved — address:", data.address);
  } catch (e) {
    console.error("Sheet error:", e.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
