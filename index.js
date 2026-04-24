const express    = require("express");
const bodyParser = require("body-parser");
const axios      = require("axios");
const crypto     = require("crypto");
const QRCode     = require("qrcode");
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

app.use(function(req, res, next) {
  if (req.path === "/flow-endpoint") {
    var raw = "";
    req.on("data", function(chunk) { raw += chunk; });
    req.on("end", function() {
      req.rawBody = raw;
      try { req.body = JSON.parse(raw); } catch(e) { req.body = {}; }
      next();
    });
  } else {
    bodyParser.json()(req, res, next);
  }
});

// =========================
// CONFIG
// =========================
const VERIFY_TOKEN            = "my_verify_token";
const PHONE_ID                = process.env.PHONE_NUMBER_ID;
const TOKEN                   = process.env.ACCESS_TOKEN;
const UPI_VPA                 = process.env.UPI_VPA                 || "9657748074-3@ibl";
const UPI_NAME                = process.env.UPI_NAME                || "Wipz";
const SUPPORT_PHONE           = process.env.SUPPORT_PHONE           || "919657748074";
const ADDRESS_FLOW_ID         = process.env.ADDRESS_FLOW_ID         || "YOUR_FLOW_ID_HERE";
const FLOW_PRIVATE_KEY        = process.env.FLOW_PRIVATE_KEY        || "";
const START_MESSAGE_VIDEO_URL = process.env.START_MESSAGE_VIDEO_URL || "YOUR_VIDEO_URL_HERE";

const PROMO_CODES = {
  "WIPZ10":  { discount: 10, type: "percent", description: "10% off"         },
  "WIPZ50":  { discount: 50, type: "flat",    description: "₹50 flat off"    },
  "LOCAL10": { discount: 10, type: "percent", description: "10% local offer" },
  "WELCOME": { discount: 15, type: "percent", description: "15% welcome off" }
};
const PROMO_PINCODES     = ["413201"];
const PINCODE_PROMO_CODE = "LOCAL10";

const userState      = {};
const userOrders     = {};
const knownCustomers = new Set();


// =========================
// WEBHOOK VERIFY
// =========================
app.get("/webhook", function(req, res) {
  var mode      = req.query["hub.mode"];
  var token     = req.query["hub.verify_token"];
  var challenge = req.query["hub.challenge"];
  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});


// =========================
// FLOW ENCRYPTION
// =========================
function decryptRequest(body) {
  var decryptedAesKey = crypto.privateDecrypt(
    { key: FLOW_PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(body.encrypted_aes_key, "base64")
  );
  var flowDataBuffer = Buffer.from(body.encrypted_flow_data, "base64");
  var iv             = Buffer.from(body.initial_vector, "base64");
  var TAG_LENGTH     = 16;
  var decipher       = crypto.createDecipheriv("aes-128-gcm", decryptedAesKey, iv);
  decipher.setAuthTag(flowDataBuffer.slice(-TAG_LENGTH));
  var decrypted = decipher.update(flowDataBuffer.slice(0, -TAG_LENGTH), undefined, "utf8") + decipher.final("utf8");
  return { decryptedBody: JSON.parse(decrypted), aesKeyBuffer: decryptedAesKey, initialVectorBuffer: iv };
}

function encryptResponse(data, aesKeyBuffer, ivBuffer) {
  var flippedIV = Buffer.alloc(ivBuffer.length);
  for (var i = 0; i < ivBuffer.length; i++) flippedIV[i] = ~ivBuffer[i];
  var cipher    = crypto.createCipheriv("aes-128-gcm", aesKeyBuffer, flippedIV);
  var encrypted = Buffer.concat([cipher.update(JSON.stringify(data), "utf-8"), cipher.final(), cipher.getAuthTag()]);
  return encrypted.toString("base64");
}


// =========================
// FLOW ENDPOINT
// =========================
app.post("/flow-endpoint", function(req, res) {
  try {
    var body = req.body;
    if (body && body.action === "ping" && !body.encrypted_aes_key) {
      return res.json({ data: { status: "active" } });
    }
    if (!body || !body.encrypted_aes_key || !body.encrypted_flow_data) {
      return res.status(421).send("Missing encryption fields");
    }
    var decryptedBody, aesKeyBuffer, initialVectorBuffer;
    try {
      var result       = decryptRequest(body);
      decryptedBody    = result.decryptedBody;
      aesKeyBuffer     = result.aesKeyBuffer;
      initialVectorBuffer = result.initialVectorBuffer;
    } catch(err) {
      console.error("Decryption failed:", err.message);
      return res.status(421).send("Decryption failed");
    }
    var action     = decryptedBody.action;
    var flow_token = decryptedBody.flow_token;
    if (action === "ping")
      return res.send(encryptResponse({ data: { status: "active" } }, aesKeyBuffer, initialVectorBuffer));
    if (action === "INIT")
      return res.send(encryptResponse({ screen: "ADDRESS", data: {} }, aesKeyBuffer, initialVectorBuffer));
    if (action === "data_exchange")
      return res.send(encryptResponse(
        { screen: "SUCCESS", data: { extension_message_response: { params: { flow_token: flow_token } } } },
        aesKeyBuffer, initialVectorBuffer
      ));
    return res.send(encryptResponse({ data: { status: "ok" } }, aesKeyBuffer, initialVectorBuffer));
  } catch(err) {
    console.error("Flow endpoint error:", err.message);
    return res.status(500).send("Internal error");
  }
});


// =========================
// HELPERS
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
  } catch(err) { console.error("Chat log error:", err.message); }
}

async function saveOrder(data) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[
        data.orderId || "", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        data.phone || "", data.product || "", data.price || "",
        data.address || "", data.status || "", data.screenshot || "", data.raw || ""
      ]]}
    });
    console.log("Order saved:", data.orderId, "| Status:", data.status);
  } catch(e) { console.error("Sheet error:", e.message); }
}

async function sendMessage(to, text) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      { messaging_product: "whatsapp", to: to, type: "text", text: { body: text } },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
  } catch(e) { console.error("Send error:", e.response && e.response.data || e.message); }
}

async function uploadToCloudinary(buf, options) {
  return new Promise(function(resolve, reject) {
    cloudinary.uploader.upload_stream(
      options || { folder: "whatsapp_orders" },
      function(err, result) { if (err) reject(err); else resolve(result.secure_url); }
    ).end(buf);
  });
}

async function getMediaUrl(mediaId) {
  try {
    var r1 = await axios.get("https://graph.facebook.com/v25.0/" + mediaId,
      { headers: { Authorization: "Bearer " + TOKEN } });
    var r2 = await axios.get(r1.data.url,
      { headers: { Authorization: "Bearer " + TOKEN }, responseType: "arraybuffer" });
    return await uploadToCloudinary(r2.data);
  } catch(e) {
    console.error("Media error:", e.response && e.response.data || e.message);
    return null;
  }
}

function buildOrderSummary(items) {
  var totalPrice = 0;
  var lineItems  = [];
  var lines      = [];
  for (var i = 0; i < items.length; i++) {
    var item      = items[i];
    var lineTotal = item.price * item.quantity;
    totalPrice   += lineTotal;
    lineItems.push({
      retailer_id: String(item.retailer_id),
      name:        item.name,
      amount:      { value: Math.round(item.price * 100), offset: 100 },
      quantity:    item.quantity
    });
    lines.push("• *" + item.name + "*  x" + item.quantity + "  — ₹" + lineTotal);
  }
  return {
    totalPrice:   totalPrice,
    lineItems:    lineItems,
    itemsSummary: lines.join("\n") + "\n\n💰 *Total: ₹" + totalPrice + "*"
  };
}

function applyPromoCode(items, code) {
  var promo = PROMO_CODES[code.trim().toUpperCase()];
  if (!promo) return { valid: false };
  var originalTotal = items.reduce(function(s, i) { return s + i.price * i.quantity; }, 0);
  var discountAmount = promo.type === "percent"
    ? Math.round(originalTotal * promo.discount / 100)
    : Math.min(promo.discount, originalTotal - 1);
  var discountedTotal = originalTotal - discountAmount;
  var ratio = discountedTotal / originalTotal;
  var discountedItems = items.map(function(item) {
    return Object.assign({}, item, { price: parseFloat((item.price * ratio).toFixed(2)) });
  });
  return {
    valid: true, items: discountedItems,
    discountAmount: discountAmount, discountedTotal: discountedTotal,
    originalTotal: originalTotal, description: promo.description
  };
}


// =========================
// SEND PAYMENT QR
//
// THREE-PART PAYMENT MESSAGE:
//
// 1. Interactive CTA button — opens UPI app directly (no scanning needed)
//    Customer taps "Pay Now" → their default UPI app opens with amount pre-filled
//
// 2. QR code sent as DOCUMENT (PDF/PNG file)
//    Customer can download & open from file manager → scan from gallery
//    Sent as document so it's saveable, not just viewable inline
//
// 3. Plain text UPI details as backup
//    UPI ID + amount + order ref for manual payment
// =========================
async function sendPaymentQR(to, orderDetails) {
  var totalPrice   = orderDetails.totalPrice;
  var itemsSummary = orderDetails.itemsSummary;
  var orderId      = orderDetails.orderId;

  // UPI deep link — opens UPI app with amount pre-filled
  var upiLink =
    "upi://pay?pa=" + UPI_VPA +
    "&pn=" + encodeURIComponent(UPI_NAME) +
    "&am=" + totalPrice +
    "&cu=INR" +
    "&tn=" + encodeURIComponent("Order " + orderId);


  // ── STEP 2: Send QR as downloadable DOCUMENT ──────────────────────
  // Customer downloads the file → opens in gallery → scans with UPI app
  try {
    var qrBuffer = await QRCode.toBuffer(upiLink, {
      type: "png", width: 600, margin: 3,
      color: { dark: "#000000", light: "#FFFFFF" }
    });

    // Upload as raw file to Cloudinary (not as image, so it's a downloadable URL)
    var qrUrl = await uploadToCloudinary(qrBuffer, {
      folder:        "wipz_qr_codes",
      resource_type: "image",
      format:        "png",
      public_id:     "qr_" + orderId
    });

    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp",
        to: to,
        type: "document",
        document: {
          link:     qrUrl,
          filename: "Wipz_Payment_QR_" + orderId + ".png",
          caption:
            "📲 *QR Code for Order " + orderId + "*\n\n" +
            "Download this file → open it → scan with GPay / PhonePe / Paytm\n\n" +
            "Amount ₹" + totalPrice + " is pre-filled in the QR ✅"
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
    console.log("QR document sent");
  } catch(err) {
    console.error("QR document error:", err.response && err.response.data || err.message);
  }

  await new Promise(function(r) { setTimeout(r, 600); });

  // ── STEP 3: Plain text UPI backup ─────────────────────────────────
  await sendMessage(to,
    "🔁 *Backup — Pay manually:*\n\n" +
    "UPI ID: *" + UPI_VPA + "*\n" +
    "Amount: *₹" + totalPrice + "*\n" +
    "Ref/Note: *" + orderId + "*\n\n" +
    "After payment, *send screenshot here* 📸\n" +
    "_Please send exact amount shown above_"
  );

  return { success: true };
}


// =========================
// PROMO OFFER BUTTONS
// =========================
async function sendPromoOfferButtons(to, promoCode) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "interactive",
        interactive: {
          type: "button",
          body: {
            text: "🎁 *Special offer for your area!*\n\nUse code *" + promoCode + "* for an exclusive discount.\n\nWould you like to apply it?"
          },
          footer: { text: "Wipz — Offers for local customers 💖" },
          action: {
            buttons: [
              { type: "reply", reply: { id: "APPLY_PROMO_" + promoCode, title: "Apply Discount"  } },
              { type: "reply", reply: { id: "SKIP_PROMO",               title: "Skip, Pay Full"  } }
            ]
          }
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
  } catch(err) { console.error("Promo button error:", err.response && err.response.data || err.message); }
}


// =========================
// WELCOME TEMPLATES
// =========================
async function sendWelcomeTemplates(to) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp", to: to, type: "template",
        template: {
          name: "start_message", language: { code: "en" },
          components: [{ type: "header", parameters: [{ type: "video", video: { link: START_MESSAGE_VIDEO_URL } }] }]
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
    console.log("start_message sent");
  } catch(err) {
    console.error("start_message error:", JSON.stringify(err.response && err.response.data, null, 2));
    await sendMessage(to, "👋 Welcome to *Wipz* 💫\n\nStylish & super-comfy Women's Footwear ✨\n🔥 Loved by 1000+ happy customers.\n_Proudly Made in Maharashtra_ 🇮🇳");
  }

  await new Promise(function(r) { setTimeout(r, 1200); });

  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp", to: to, type: "template",
        template: {
          name: "intro_catalog", language: { code: "en" },
          components: [{ type: "button", sub_type: "CATALOG", index: "0",
            parameters: [{ type: "action", action: { thumbnail_product_retailer_id: "" } }] }]
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
    console.log("intro_catalog sent");
  } catch(err) { console.error("intro_catalog error:", JSON.stringify(err.response && err.response.data, null, 2)); }
}


// =========================
// RETURNING CUSTOMER MENU
// =========================
async function sendReturningCustomerMenu(to) {
  await sendWelcomeTemplates(to);
  await new Promise(function(r) { setTimeout(r, 1500); });
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp", recipient_type: "individual", to: to, type: "interactive",
        interactive: {
          type: "button",
          body: { text: "Welcome back to *Wipz*! 💖\n\nShop again or need help with a previous order?" },
          footer: { text: "Wipz — Always here for you!" },
          action: {
            buttons: [
              { type: "reply", reply: { id: "SHOP_AGAIN",    title: "Shop Again"    } },
              { type: "reply", reply: { id: "ORDER_SUPPORT", title: "Order Support" } },
              { type: "reply", reply: { id: "CALL_SUPPORT",  title: "Call Us"       } }
            ]
          }
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
  } catch(err) { console.error("Returning menu error:", err.response && err.response.data || err.message); }
}


// =========================
// ORDER SUPPORT MENU
// Clean list — no phone number in each option
// Phone only shown when customer explicitly taps "Call Us"
// =========================
async function sendOrderSupportMenu(to) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp", recipient_type: "individual", to: to, type: "interactive",
        interactive: {
          type: "list",
          body: { text: "We are here to help! 🙏\n\nSelect what you need assistance with:" },
          footer: { text: "Wipz Customer Support" },
          action: {
            button: "Select Option",
            sections: [{
              title: "Order Help",
              rows: [
                { id: "ORDER_STATUS",   title: "Order Status",    description: "Check where your order is"    },
                { id: "RETURN_REQUEST", title: "Return Request",  description: "Return within 7 days"         },
                { id: "REPLACEMENT",    title: "Replacement",     description: "Damaged or wrong item"        },
                { id: "REFUND",         title: "Refund Status",   description: "Check your refund progress"   },
                { id: "TALK_TO_US",     title: "Talk to Us",      description: "Speak to our team directly"   }
              ]
            }]
          }
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
  } catch(err) { console.error("Support menu error:", err.response && err.response.data || err.message); }
}


// =========================
// ADDRESS FLOW
// =========================
async function sendAddressFlow(to) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp", recipient_type: "individual", to: to, type: "interactive",
        interactive: {
          type: "flow",
          header: { type: "text", text: "Delivery Details" },
          body:   { text: "Please fill in your delivery address so we can ship your order 🚚" },
          footer: { text: "Wipz — Fast & Secure Delivery 💖" },
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              flow_token: "ADDR_" + to + "_" + Date.now(),
              flow_id: ADDRESS_FLOW_ID,
              flow_cta: "Enter Delivery Address",
              flow_action: "navigate",
              flow_action_payload: { screen: "ADDRESS" }
            }
          }
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
  } catch(err) {
    console.error("Address flow error:", JSON.stringify(err.response && err.response.data, null, 2));
    await sendMessage(to, "📦 Please send your delivery details:\n\nName:\nPhone:\nHouse No.:\nArea & Street:\nLandmark:\nCity:\nPincode:");
  }
}


// =========================
// ORDER STATUS UPDATE
// =========================
async function sendOrderStatusUpdate(to, referenceId, status) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp", to: to, type: "interactive",
        interactive: {
          type: "order_status",
          body: { text: status === "processing" ? "✅ Payment received! Your order is being processed." : "📦 Order status: " + status },
          action: { name: "review_order", parameters: { reference_id: referenceId, order: { status: status, description: "" } } }
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
  } catch(err) { console.error("Order status error:", err.response && err.response.data || err.message); }
}


// =========================
// MAIN WEBHOOK
// =========================
app.post("/webhook", async function(req, res) {
  try {
    var body        = req.body;
    var incomingMsg = body &&
                      body.entry && body.entry[0] &&
                      body.entry[0].changes && body.entry[0].changes[0] &&
                      body.entry[0].changes[0].value &&
                      body.entry[0].changes[0].value.messages &&
                      body.entry[0].changes[0].value.messages[0];

    if (!incomingMsg) return res.sendStatus(200);

    var from = incomingMsg.from;
    var type = incomingMsg.type;

    if (!userState[from]) {
      userState[from] = { step: "idle", seenWelcome: false, hasOrders: false };
    }

    // ── PAYMENT STATUS (WhatsApp native) ───────────────────────────
    if (type === "interactive" && incomingMsg.interactive && incomingMsg.interactive.type === "payment_info") {
      var pi          = incomingMsg.interactive.payment_info;
      var piStatus    = pi && pi.payment_status;
      var referenceId = pi && pi.reference_id;
      var txnId       = pi && pi.transaction_id;
      var amount      = pi && pi.total_amount ? pi.total_amount.value / 100 : 0;

      if (piStatus === "captured") {
        knownCustomers.add(from);
        var pSummary2 = userOrders[from] && userOrders[from].items
          ? userOrders[from].items.map(function(i) { return i.name + " x" + i.quantity; }).join(", ")
          : "";
        await saveOrder({
          orderId: referenceId, phone: from, product: pSummary2, price: amount,
          address: userOrders[from] ? userOrders[from].address || "" : "",
          status: "PAID", screenshot: "UPI TXN: " + txnId, raw: JSON.stringify(pi)
        });
        userState[from] = { step: "done", seenWelcome: true, hasOrders: true };
        await sendMessage(from,
          "✅ *Payment Confirmed!*\n\n🧾 Order ID: *" + referenceId + "*\n💰 Amount: ₹" + amount +
          "\n🔖 UTR: " + txnId + "\n\nYour order is being processed 🚚\n\n💖 Thank you for shopping with *Wipz*!"
        );
        await sendOrderStatusUpdate(from, referenceId, "processing");
      } else if (piStatus === "failed") {
        await sendMessage(from, "❌ Payment failed. Please try again 👇");
      }
      return res.sendStatus(200);
    }

    // ── BUTTON REPLY ────────────────────────────────────────────────
    if (type === "interactive" && incomingMsg.interactive && incomingMsg.interactive.type === "button_reply") {
      var btnId = incomingMsg.interactive.button_reply && incomingMsg.interactive.button_reply.id;

      if (btnId === "SHOP_AGAIN") {
        userState[from] = { step: "idle", seenWelcome: true, hasOrders: userState[from].hasOrders };
        userOrders[from] = null;
        await sendMessage(from, "😍 Let's find your next favourite pair!\n\n🛍️ Browse our catalogue and select a product 👆");

      } else if (btnId === "ORDER_SUPPORT") {
        userState[from].step = "support";
        await sendOrderSupportMenu(from);

      } else if (btnId === "CALL_SUPPORT") {
        // Only show phone when customer explicitly taps "Call Us"
        await sendMessage(from,
          "📞 *Call or WhatsApp us:*\n\n+" + SUPPORT_PHONE +
          "\n\n_Mon–Sat: 10am – 7pm_\n\nWe're happy to help! 😊"
        );

      } else if (btnId && btnId.startsWith("APPLY_PROMO_")) {
        var autoCode    = btnId.replace("APPLY_PROMO_", "");
        var promoResult = applyPromoCode(userOrders[from] && userOrders[from].items || [], autoCode);
        if (promoResult.valid) {
          var pOId  = userOrders[from].pendingOrderId;
          var pSum  = buildOrderSummary(promoResult.items);
          userState[from].step = "payment";
          userOrders[from].finalPrice = promoResult.discountedTotal;
          await sendMessage(from,
            "✅ *Discount applied!*\n\n" + promoResult.description +
            "\nOriginal: ₹" + promoResult.originalTotal +
            "\nYou save: ₹" + promoResult.discountAmount +
            "\n💰 *You pay: ₹" + promoResult.discountedTotal + "*"
          );
          await new Promise(function(r) { setTimeout(r, 600); });
          await sendPaymentQR(from, { totalPrice: pSum.totalPrice, itemsSummary: pSum.itemsSummary, orderId: pOId });
        }

      } else if (btnId === "SKIP_PROMO") {
        var skOId  = userOrders[from] && userOrders[from].pendingOrderId;
        var skSum  = buildOrderSummary(userOrders[from] && userOrders[from].items || []);
        userState[from].step = "payment";
        await sendMessage(from, "Here's your payment 👇");
        await sendPaymentQR(from, { totalPrice: skSum.totalPrice, itemsSummary: skSum.itemsSummary, orderId: skOId });
      }

      return res.sendStatus(200);
    }

    // ── LIST REPLY (support options) ────────────────────────────────
    if (type === "interactive" && incomingMsg.interactive && incomingMsg.interactive.type === "list_reply") {
      var listId = incomingMsg.interactive.list_reply && incomingMsg.interactive.list_reply.id;

      // Clean support messages — no phone number repeated in every message
      // Phone only shown for TALK_TO_US option
      var supportMsgs = {
        ORDER_STATUS:
          "📦 *Order Status*\n\n" +
          "Please share your *Order ID* (starts with ORD...) and we'll check the status for you right away.",

        RETURN_REQUEST:
          "↩️ *Return Request*\n\n" +
          "We accept returns within *7 days* of delivery.\n\n" +
          "Please share:\n• Your Order ID\n• Reason for return\n• Photo of the product\n\n" +
          "Our team will get back to you shortly.",

        REPLACEMENT:
          "🔄 *Replacement Request*\n\n" +
          "We're sorry to hear that! Please share:\n• Your Order ID\n• Photo of the damaged or wrong item\n\n" +
          "We'll arrange a replacement as soon as possible.",

        REFUND:
          "💰 *Refund Status*\n\n" +
          "Refunds are processed within *5–7 working days* after the return is picked up.\n\n" +
          "Please share your *Order ID* and we'll update you on the status.",

        TALK_TO_US:
          "📞 *Talk to Our Team*\n\n" +
          "Call or WhatsApp us directly:\n*+" + SUPPORT_PHONE + "*\n\n" +
          "_Mon–Sat: 10am – 7pm_\n\nWe're happy to help! 😊"
      };

      await sendMessage(from, supportMsgs[listId] || supportMsgs["TALK_TO_US"]);
      userState[from].step = "support_detail";
      return res.sendStatus(200);
    }

    // ── FLOW COMPLETION (address form) ──────────────────────────────
    if (type === "interactive" && incomingMsg.interactive && incomingMsg.interactive.type === "nfm_reply") {
      var formData = {};
      try {
        formData = JSON.parse(incomingMsg.interactive.nfm_reply && incomingMsg.interactive.nfm_reply.response_json || "{}");
      } catch(e) { formData = {}; }

      console.log("Form data:", JSON.stringify(formData, null, 2));

      var full_name      = formData.full_name      || "";
      var fPhone         = formData.phone          || "";
      var address_line_1 = formData.address_line_1 || "";
      var address_line_2 = formData.address_line_2 || "";
      var address_line_3 = formData.address_line_3 || "";
      var city           = formData.city           || "";
      var pincode        = formData.pincode        || "";

      var fullAddress = [
        full_name,
        fPhone ? "Ph: " + fPhone : "",
        address_line_1, address_line_2, address_line_3,
        city, pincode
      ].filter(Boolean).join(", ");

      await saveChatLog({ phone: from, message: "ADDRESS: " + fullAddress, step: "address_submitted" });

      if (!userOrders[from]) userOrders[from] = { items: [] };
      userOrders[from].address = fullAddress;

      if (!userOrders[from].items || userOrders[from].items.length === 0) {
        await sendMessage(from, "👉 Please select a product from catalogue first 🛍️");
        return res.sendStatus(200);
      }

      var now     = new Date();
      var orderId =
        "ORD" +
        now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }).replace(/\//g, "") +
        "-" + now.getTime().toString().slice(-5);

      userOrders[from].orderId        = orderId;
      userOrders[from].pendingOrderId = orderId;

      if (PROMO_PINCODES.indexOf(String(pincode).trim()) !== -1) {
        userState[from].step = "awaiting_promo";
        await sendPromoOfferButtons(from, PINCODE_PROMO_CODE);
      } else {
        userState[from].step = "awaiting_promo_text";
        await sendMessage(from,
          "🎉 Almost there!\n\nDo you have a *promo code*? Type it now for a discount.\n\nOr type *SKIP* to continue."
        );
      }

      return res.sendStatus(200);
    }

    // ── CHAT LOG ────────────────────────────────────────────────────
    var logMessage = (incomingMsg.text && incomingMsg.text.body) || type;
    if (type === "order" && incomingMsg.order && incomingMsg.order.product_items) {
      logMessage = incomingMsg.order.product_items.map(function(p) {
        return p.product_retailer_id + " x" + p.quantity;
      }).join(", ") || "Order";
    }
    await saveChatLog({ phone: from, message: logMessage, step: userState[from].step });

    // ── GREETING / FIRST MESSAGE ─────────────────────────────────────
    var textBody   = incomingMsg.text && incomingMsg.text.body ? incomingMsg.text.body.toLowerCase().trim() : "";
    var greetings  = ["hi", "hello", "start", "hey", "hii", "helo"];
    var isGreeting = type === "text" && greetings.indexOf(textBody) !== -1;

    if (!userState[from].seenWelcome || isGreeting) {
      userState[from].seenWelcome = true;
      var isReturning = knownCustomers.has(from) || userState[from].hasOrders;
      if (isReturning) {
        userState[from] = { step: "idle", seenWelcome: true, hasOrders: true };
        userOrders[from] = null;
        await sendReturningCustomerMenu(from);
      } else {
        userState[from].step = "idle";
        userOrders[from]     = null;
        await sendWelcomeTemplates(from);
      }
      if (type !== "order") return res.sendStatus(200);
    }

    // ── ORDER FROM CATALOG ───────────────────────────────────────────
    if (type === "order") {
      var products = (incomingMsg.order && incomingMsg.order.product_items) || [];
      if (products.length === 0) return res.sendStatus(200);

      if (!userOrders[from] || userState[from].step === "done") {
        userOrders[from] = { items: [] };
        userState[from].step = "idle";
      }

      for (var pi2 = 0; pi2 < products.length; pi2++) {
        var p        = products[pi2];
        var existing = null;
        for (var ei = 0; ei < (userOrders[from].items || []).length; ei++) {
          if (userOrders[from].items[ei].retailer_id === p.product_retailer_id) {
            existing = userOrders[from].items[ei]; break;
          }
        }
        if (existing) {
          existing.quantity += (p.quantity || 1);
        } else {
          if (!userOrders[from].items) userOrders[from].items = [];
          userOrders[from].items.push({
            retailer_id: p.product_retailer_id,
            name:        p.product_retailer_id,
            price:       p.item_price  || 0,
            quantity:    p.quantity    || 1,
            imageUrl:    p.image && p.image.link ? p.image.link : null
          });
        }
      }

      var allItems  = userOrders[from].items;
      var cartTotal = allItems.reduce(function(s, i) { return s + i.price * i.quantity; }, 0);

      var firstWithImage = null;
      for (var ii = 0; ii < allItems.length; ii++) {
        if (allItems[ii].imageUrl) { firstWithImage = allItems[ii]; break; }
      }
      if (firstWithImage) {
        try {
          await axios.post(
            "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
            {
              messaging_product: "whatsapp", to: from, type: "image",
              image: {
                link: firstWithImage.imageUrl,
                caption: allItems.map(function(i) {
                  return "🛍️ *" + i.name + "*  |  Qty: " + i.quantity + "  |  ₹" + (i.price * i.quantity);
                }).join("\n")
              }
            },
            { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
          );
        } catch(e) { console.error("Image send error:", e.message); }
      }

      var cartLines = allItems.map(function(i) {
        return "• *" + i.name + "*  x" + i.quantity + "  — ₹" + (i.price * i.quantity);
      }).join("\n");

      await sendMessage(from, "🛒 *Your Cart:*\n\n" + cartLines + "\n\n💰 *Total: ₹" + cartTotal + "*");
      userState[from].step = "awaiting_address_flow";
      await sendAddressFlow(from);
      return res.sendStatus(200);
    }

    // ── TEXT FALLBACK ────────────────────────────────────────────────
    if (type === "text") {
      var step = userState[from].step;

      if (step === "payment") {
        var currentTotal = userOrders[from] && userOrders[from].finalPrice ||
          (userOrders[from] && userOrders[from].items
            ? userOrders[from].items.reduce(function(s,i){return s+i.price*i.quantity;},0)
            : 0);
        await sendMessage(from,
          "📸 Please send your *payment screenshot* after paying.\n\n" +
          "Amount to pay: *₹" + currentTotal + "*\n" +
          "Order ID: *" + (userOrders[from] && userOrders[from].orderId || "") + "*"
        );

      } else if (step === "awaiting_address_flow") {
        await sendMessage(from, "📋 Please fill in the delivery form above 👆");

      } else if (step === "awaiting_promo_text") {
        var typedCode = incomingMsg.text.body.trim().toUpperCase();
        if (typedCode === "SKIP") {
          var skOId2  = userOrders[from] && userOrders[from].pendingOrderId;
          var skSum2  = buildOrderSummary(userOrders[from] && userOrders[from].items || []);
          userState[from].step = "payment";
          await sendMessage(from, "Here's your payment 👇");
          await sendPaymentQR(from, { totalPrice: skSum2.totalPrice, itemsSummary: skSum2.itemsSummary, orderId: skOId2 });
        } else {
          var pResult2 = applyPromoCode(userOrders[from] && userOrders[from].items || [], typedCode);
          if (pResult2.valid) {
            var ptOId2  = userOrders[from] && userOrders[from].pendingOrderId;
            var ptSum2  = buildOrderSummary(pResult2.items);
            userState[from].step = "payment";
            userOrders[from].finalPrice = pResult2.discountedTotal;
            await sendMessage(from,
              "✅ *Promo applied!*\n\n" + pResult2.description +
              "\nYou save: ₹" + pResult2.discountAmount +
              "\n💰 *You pay: ₹" + pResult2.discountedTotal + "*"
            );
            await new Promise(function(r) { setTimeout(r, 600); });
            await sendPaymentQR(from, { totalPrice: ptSum2.totalPrice, itemsSummary: ptSum2.itemsSummary, orderId: ptOId2 });
          } else {
            await sendMessage(from, "❌ Invalid promo code. Try again or type *SKIP* to continue without discount.");
          }
        }

      } else if (step === "awaiting_promo") {
        await sendMessage(from, "👆 Please tap *Apply Discount* or *Skip* above.");

      } else if (step === "support" || step === "support_detail") {
        await sendMessage(from, "Please select an option from the menu above, or type your concern and we'll respond soon 🙏");

      } else {
        await sendMessage(from, "👉 Please select a product from catalogue to continue 🛍️");
      }
      return res.sendStatus(200);
    }

    // ── SCREENSHOT (payment proof) ───────────────────────────────────
    if (type === "image" && userState[from].step === "payment") {
      var imgUrl   = await getMediaUrl(incomingMsg.image && incomingMsg.image.id);
      var scrOrdId = userOrders[from] && userOrders[from].orderId || "ORD-MANUAL";
      var scrProd  = userOrders[from] && userOrders[from].items
        ? userOrders[from].items.map(function(i) { return i.name + " x" + i.quantity; }).join(", ")
        : "";
      var scrTotal = userOrders[from] && userOrders[from].finalPrice ||
                     (userOrders[from] && userOrders[from].items
                       ? userOrders[from].items.reduce(function(s,i){return s+i.price*i.quantity;},0)
                       : 0);

      userOrders[from].status = "screenshot_received";
      userState[from].step    = "done";
      knownCustomers.add(from);

      // Save full order to Sheet1 with screenshot URL
      await saveOrder({
        orderId:    scrOrdId,
        phone:      from,
        product:    scrProd,
        price:      scrTotal,
        address:    userOrders[from].address || "",
        status:     "Screenshot received — verify payment",
        screenshot: imgUrl,
        raw:        JSON.stringify(userOrders[from])
      });

      await sendMessage(from,
        "✅ *Screenshot received!*\n\n" +
        "🧾 Order ID: *" + scrOrdId + "*\n" +
        "💰 Amount: ₹" + scrTotal + "\n\n" +
        "We'll verify your payment and process your order shortly 🚚\n\n" +
        "💖 Thank you for shopping with *Wipz*!"
      );
      return res.sendStatus(200);
    }

    res.sendStatus(200);

  } catch(err) {
    console.error("Webhook error:", err.response && err.response.data || err.message);
    res.sendStatus(500);
  }
});


var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});
