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
const START_MESSAGE_IMAGE_URL = process.env.START_MESSAGE_IMAGE_URL || "YOUR_IMAGE_URL_HERE";

// Razorpay payment config — exact name from WhatsApp Manager → Payment configurations
const RAZORPAY_CONFIG_NAME = "razorpay";

// Promo codes — only for PROMO_PINCODES, all others go straight to payment
const PROMO_CODES = {
  "JAMKHED10": { discount: 10, type: "percent", description: "10% off for Jamkhed customers" }
};
const PROMO_PINCODES     = ["413201"];
const PINCODE_PROMO_CODE = "JAMKHED10";

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
    if (body && body.action === "ping" && !body.encrypted_aes_key)
      return res.json({ data: { status: "active" } });
    if (!body || !body.encrypted_aes_key || !body.encrypted_flow_data)
      return res.status(421).send("Missing encryption fields");
    var decryptedBody, aesKeyBuffer, initialVectorBuffer;
    try {
      var result = decryptRequest(body);
      decryptedBody       = result.decryptedBody;
      aesKeyBuffer        = result.aesKeyBuffer;
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
// CORE HELPERS
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

// Sheet1 columns:
// A:OrderID | B:Date | C:Phone | D:Product | E:Price | F:Address | G:Email | H:Status | I:TXN | J:Raw
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
        data.address    || "",
        data.email      || "",
        data.status     || "",
        data.txn        || "",
        data.raw        || ""
      ]]}
    });
    console.log("Sheet1 saved:", data.orderId, "|", data.status);
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
  var originalTotal  = items.reduce(function(s, i) { return s + i.price * i.quantity; }, 0);
  var discountAmount = promo.type === "percent"
    ? Math.round(originalTotal * promo.discount / 100)
    : Math.min(promo.discount, originalTotal - 1);
  var discountedTotal = originalTotal - discountAmount;
  var ratio           = discountedTotal / originalTotal;
  var discountedItems = items.map(function(item) {
    return Object.assign({}, item, { price: parseFloat((item.price * ratio).toFixed(2)) });
  });
  return {
    valid: true, items: discountedItems,
    discountAmount: discountAmount, discountedTotal: discountedTotal,
    originalTotal: originalTotal, description: promo.description
  };
}

// Calculate estimated delivery date (5-7 business days from now)
function getEstimatedDelivery() {
  var date    = new Date();
  var days    = 0;
  var added   = 0;
  while (added < 7) {
    date.setDate(date.getDate() + 1);
    var day = date.getDay();
    if (day !== 0 && day !== 6) added++;  // skip Sunday(0) and Saturday(6)
    if (added === 5) { days = 5; }
  }
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
}


// =========================
// SEND RAZORPAY PAYMENT MESSAGE
// Correct structure per Meta docs:
// payment_settings array → type: "payment_gateway" → payment_gateway object
// =========================
async function sendPaymentMessage(to, orderDetails) {
  var totalPrice   = orderDetails.totalPrice;
  var lineItems    = orderDetails.lineItems;
  var itemsSummary = orderDetails.itemsSummary;
  var orderId      = orderDetails.orderId;
  var discountAmt  = orderDetails.discountAmount || 0;

  var amountInPaise   = Math.round(totalPrice * 100);
  var subtotalInPaise = amountInPaise + Math.round(discountAmt * 100);
  var discountInPaise = Math.round(discountAmt * 100);

  var itemsWithDetails = lineItems.map(function(item) {
    return {
      retailer_id:       item.retailer_id,
      name:              item.name,
      amount:            item.amount,
      quantity:          item.quantity,
      country_of_origin: "India",
      importer_name:     "Wipz Footcare Industries",
      importer_address:  {
        address_line1: "SR. NO. 1018, Karjat Road",
        city:          "Jamkhed, Ahilyanagar",
        zone_code:     "MH",
        postal_code:   "413201",
        country_code:  "IN"
      }
    };
  });

  var payload = {
    messaging_product: "whatsapp",
    recipient_type:    "individual",
    to:                to,
    type:              "interactive",
    interactive: {
      type: "order_details",
      body: {
        text:
          "Here's your order summary 🛍️\n\n" +
          itemsSummary +
          "\n\nTap *Review & Pay* to complete payment ✅\n" +
          "_Pay via UPI, Card, Netbanking or Wallet_"
      },
      footer: { text: "Wipz — Secure payment via Razorpay 🔒" },
      action: {
        name: "review_and_pay",
        parameters: {
          reference_id: orderId,
          type:         "physical-goods",
          payment_settings: [
            {
              type: "payment_gateway",
              payment_gateway: {
                type:               "razorpay",
                configuration_name: RAZORPAY_CONFIG_NAME,
                razorpay: {
                  receipt: orderId,
                  notes: { order_id: orderId, source: "whatsapp_bot" }
                }
              }
            }
          ],
          currency:     "INR",
          total_amount: { value: amountInPaise, offset: 100 },
          order: {
            status:   "pending",
            items:    itemsWithDetails,
            subtotal: { value: subtotalInPaise, offset: 100 },
            tax:      { value: 0, offset: 100, description: "GST Inclusive"  },
            shipping: { value: 0, offset: 100, description: "Free Delivery"  },
            discount: {
              value:       discountInPaise,
              offset:      100,
              description: discountAmt > 0 ? "Promo discount applied" : ""
            }
          }
        }
      }
    }
  };

  console.log("Sending Razorpay payment, order:", orderId, "₹" + totalPrice);

  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      payload,
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
    console.log("✅ Razorpay payment message sent:", orderId);
    return { success: true };
  } catch(error) {
    var errData = error.response && error.response.data;
    console.error("❌ Razorpay payment failed:", JSON.stringify(errData, null, 2));
    return { success: false };
  }
}


// =========================
// TRIGGER PAYMENT
// =========================
async function triggerPayment(from, orderId, items, discountAmount) {
  discountAmount = discountAmount || 0;
  var summary = buildOrderSummary(items);
  userState[from].step = "payment";
  await sendMessage(from, "🎉 Almost there! Here's your order 👇");
  var result = await sendPaymentMessage(from, {
    totalPrice:     summary.totalPrice,
    lineItems:      summary.lineItems,
    itemsSummary:   summary.itemsSummary,
    orderId:        orderId,
    discountAmount: discountAmount
  });
  if (!result.success) {
    // Only if Razorpay message itself fails to send — show UPI as last resort
    await sendMessage(from,
      "⚠️ Payment button failed to load. Please pay manually:\n\n" +
      "UPI ID: *" + UPI_VPA + "*\n" +
      "Amount: *₹" + summary.totalPrice + "*\n" +
      "Ref: *" + orderId + "*\n\n" +
      "Send screenshot after payment 📸"
    );
  }
}


// =========================
// SEND ORDER STATUS UPDATE
// =========================
async function sendOrderStatusUpdate(to, referenceId, status) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp",
        recipient_type:    "individual",
        to: to,
        type: "interactive",
        interactive: {
          type: "order_status",
          body: {
            text: status === "processing"
              ? "✅ Your payment was received and your order is being processed!"
              : "📦 Your order status: " + status
          },
          action: {
            name: "review_order",
            parameters: {
              reference_id: referenceId,
              order: { status: status, description: "" }
            }
          }
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
  } catch(err) { console.error("Order status error:", err.response && err.response.data || err.message); }
}


// =========================
// SEND WELCOME TEMPLATES
// Uses IMAGE header (PNG) for start_message
// =========================
async function sendWelcomeTemplates(to) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp", to: to, type: "template",
        template: {
          name: "start_message", language: { code: "en" },
          components: [
            {
              type: "header",
              parameters: [{ type: "image", image: { link: START_MESSAGE_IMAGE_URL } }]
            }
          ]
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
    console.log("start_message sent");
  } catch(err) {
    console.error("start_message error:", JSON.stringify(err.response && err.response.data, null, 2));
    await sendMessage(to,
      "👋 Welcome to *Wipz* 💫\n\n" +
      "Stylish & super-comfy Women's Footwear ✨\n" +
      "🔥 Loved by 100000+ happy customers.\n" +
      "_Proudly Made in Maharashtra_ 🇮🇳"
    );
  }
  await new Promise(function(r) { setTimeout(r, 1200); });
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp", to: to, type: "template",
        template: {
          name: "intro_catalog", language: { code: "en" },
          components: [
            { type: "button", sub_type: "CATALOG", index: "0",
              parameters: [{ type: "action", action: { thumbnail_product_retailer_id: "" } }] }
          ]
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
    console.log("intro_catalog sent");
  } catch(err) {
    console.error("intro_catalog error:", JSON.stringify(err.response && err.response.data, null, 2));
  }
}

async function sendCatalogTemplate(to) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp", to: to, type: "template",
        template: {
          name: "intro_catalog", language: { code: "en" },
          components: [
            { type: "button", sub_type: "CATALOG", index: "0",
              parameters: [{ type: "action", action: { thumbnail_product_retailer_id: "" } }] }
          ]
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
  } catch(err) { console.error("Catalog template error:", err.response && err.response.data || err.message); }
}

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
          body: { text: "Welcome back to *Wipz*! 💖\n\nWhat would you like to do?" },
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
                { id: "ORDER_STATUS",   title: "Order Status",   description: "Check where your order is"  },
                { id: "RETURN_REQUEST", title: "Return Request", description: "Return within 7 days"       },
                { id: "REPLACEMENT",    title: "Replacement",    description: "Damaged or wrong item"      },
                { id: "REFUND",         title: "Refund Status",  description: "Check your refund progress" },
                { id: "TALK_TO_US",     title: "Talk to Us",     description: "Speak to our team directly" }
              ]
            }]
          }
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
  } catch(err) { console.error("Support menu error:", err.response && err.response.data || err.message); }
}

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
    await sendMessage(to, "📦 Please send your delivery details:\n\nName:\nPhone:\nEmail:\nHouse No.:\nArea & Street:\nLandmark:\nCity:\nPincode:");
  }
}

async function sendPromoOfferButtons(to, promoCode) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp", recipient_type: "individual", to: to, type: "interactive",
        interactive: {
          type: "button",
          body: {
            text:
              "🎁 *Special offer for Jamkhed customers!*\n\n" +
              "You can get *10% off* on your order.\n\n" +
              "Would you like to apply it?"
          },
          footer: { text: "Wipz — Exclusive local offer 💖" },
          action: {
            buttons: [
              { type: "reply", reply: { id: "APPLY_PROMO_" + promoCode, title: "Apply 10% Off" } },
              { type: "reply", reply: { id: "SKIP_PROMO",               title: "No Thanks"     } }
            ]
          }
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
  } catch(err) { console.error("Promo button error:", err.response && err.response.data || err.message); }
}


// =========================
// MAIN WEBHOOK
// =========================
app.post("/webhook", async function(req, res) {
  try {
    var body    = req.body;
    var value   = body &&
                  body.entry && body.entry[0] &&
                  body.entry[0].changes && body.entry[0].changes[0] &&
                  body.entry[0].changes[0].value;

    if (!value) return res.sendStatus(200);

    // ================================================================
    // ✅ RAZORPAY PAYMENT STATUS
    // Payment confirmation comes in value.statuses[] NOT value.messages[]
    // type: "payment" with status: "captured" | "failed" | "pending"
    // ================================================================
    var statuses = value.statuses || [];
    for (var si = 0; si < statuses.length; si++) {
      var statusObj = statuses[si];
      if (statusObj.type === "payment") {
        var from        = statusObj.recipient_id;
        var piStatus    = statusObj.status;           // "captured" | "failed" | "pending"
        var payment     = statusObj.payment || {};
        var referenceId = payment.reference_id;
        var amount      = payment.amount ? payment.amount.value / 100 : 0;
        var txnId       = statusObj.id;               // webhook message ID
        var receipt     = payment.receipt || "";

        console.log("💰 Payment status:", piStatus, "| Order:", referenceId, "| TXN:", txnId, "| ₹" + amount);

        if (piStatus === "captured") {
          knownCustomers.add(from);

          var pSumStr = userOrders[from] && userOrders[from].items
            ? userOrders[from].items.map(function(i) { return i.name + " x" + i.quantity; }).join(", ")
            : "";

          var deliveryDate = getEstimatedDelivery();

          // Save to Sheet1
          await saveOrder({
            orderId:  referenceId,
            phone:    from,
            product:  pSumStr,
            price:    amount,
            address:  userOrders[from] ? userOrders[from].address || "" : "",
            email:    userOrders[from] ? userOrders[from].email   || "" : "",
            status:   "PAID via Razorpay ✅",
            txn:      "Razorpay TXN: " + txnId + (receipt ? " | Receipt: " + receipt : ""),
            raw:      JSON.stringify(statusObj)
          });

          // Log it too
          await saveChatLog({ phone: from, message: "PAYMENT CAPTURED: " + referenceId + " ₹" + amount, step: "paid" });

          userState[from] = { step: "done", seenWelcome: true, hasOrders: true };

          // Send receipt / confirmation to customer
          await sendMessage(from,
            "✅ *Payment Confirmed!*\n\n" +
            "━━━━━━━━━━━━━━\n" +
            "🧾 *Order ID:* " + referenceId + "\n" +
            "💰 *Amount Paid:* ₹" + amount + "\n" +
            "🏷️ *Products:* " + pSumStr + "\n" +
            "📦 *Estimated Delivery:* " + deliveryDate + "\n" +
            "━━━━━━━━━━━━━━\n\n" +
            "Your order is being packed and will be shipped soon 🚚\n\n" +
            "We'll send you a shipping update here once dispatched.\n\n" +
            "💖 *Thank you for shopping with Wipz!*\n" +
            "_Proudly Made in Maharashtra_ 🇮🇳\n\n" +
            "For any help: 📞 +" + SUPPORT_PHONE
          );

          // Update the order card status in WhatsApp chat
          await sendOrderStatusUpdate(from, referenceId, "processing");

        } else if (piStatus === "failed") {
          console.log("Payment failed for order:", referenceId);
          await saveChatLog({ phone: from, message: "PAYMENT FAILED: " + referenceId, step: "payment_failed" });

          await sendMessage(from,
            "❌ *Payment Failed*\n\n" +
            "Your payment for Order *" + referenceId + "* could not be processed.\n\n" +
            "Please tap *Review & Pay* above to try again, or contact us:\n" +
            "📞 +" + SUPPORT_PHONE
          );

          // Resend payment message so they can retry
          if (userOrders[from] && userOrders[from].items) {
            await new Promise(function(r) { setTimeout(r, 1000); });
            await triggerPayment(from, referenceId, userOrders[from].items,
              userOrders[from].discountAmount || 0);
          }

        } else if (piStatus === "pending") {
          console.log("Payment pending for order:", referenceId);
        }
      }
    }

    // ================================================================
    // Normal message handling
    // ================================================================
    var messages = value.messages || [];
    var message  = messages[0];
    if (!message) return res.sendStatus(200);

    var from = message.from;
    var type = message.type;

    if (!userState[from]) {
      userState[from] = { step: "idle", seenWelcome: false, hasOrders: false };
    }

    // ── BUTTON REPLY ────────────────────────────────────────────────
    if (type === "interactive" && message.interactive && message.interactive.type === "button_reply") {
      var btnId = message.interactive.button_reply && message.interactive.button_reply.id;

      if (btnId === "SHOP_AGAIN") {
        userState[from] = { step: "idle", seenWelcome: true, hasOrders: true };
        userOrders[from] = null;
        await sendMessage(from, "😍 Let's find your next favourite pair! 👟\n\nBrowse our latest collection below 👇");
        await new Promise(function(r) { setTimeout(r, 600); });
        await sendCatalogTemplate(from);

      } else if (btnId === "ORDER_SUPPORT") {
        userState[from].step = "support";
        await sendOrderSupportMenu(from);

      } else if (btnId === "CALL_SUPPORT") {
        await sendMessage(from,
          "📞 *Call or WhatsApp us:*\n\n+" + SUPPORT_PHONE +
          "\n\n_Mon–Sat: 10am – 7pm_\n\nWe're happy to help! 😊"
        );

      } else if (btnId && btnId.startsWith("APPLY_PROMO_")) {
        var autoCode    = btnId.replace("APPLY_PROMO_", "");
        var promoResult = applyPromoCode(userOrders[from] && userOrders[from].items || [], autoCode);
        if (promoResult.valid) {
          var pOId = userOrders[from] && userOrders[from].pendingOrderId;
          userOrders[from].finalPrice     = promoResult.discountedTotal;
          userOrders[from].discountAmount = promoResult.discountAmount;
          userOrders[from].items          = promoResult.items;
          await sendMessage(from,
            "✅ *Discount applied!*\n\n" + promoResult.description +
            "\nOriginal: ₹" + promoResult.originalTotal +
            "\nYou save: ₹" + promoResult.discountAmount +
            "\n💰 *You pay: ₹" + promoResult.discountedTotal + "*"
          );
          await new Promise(function(r) { setTimeout(r, 600); });
          await triggerPayment(from, pOId, promoResult.items, promoResult.discountAmount);
        }

      } else if (btnId === "SKIP_PROMO") {
        var skOId = userOrders[from] && userOrders[from].pendingOrderId;
        await triggerPayment(from, skOId, userOrders[from] && userOrders[from].items || [], 0);
      }

      return res.sendStatus(200);
    }

    // ── LIST REPLY (support) ─────────────────────────────────────────
    if (type === "interactive" && message.interactive && message.interactive.type === "list_reply") {
      var listId = message.interactive.list_reply && message.interactive.list_reply.id;

      await saveChatLog({ phone: from, message: "SUPPORT: " + listId, step: "support" });

      if (listId === "ORDER_STATUS") {
        userState[from].step = "support_order_status";
        await sendMessage(from,
          "📦 *Order Status*\n\n" +
          "Please share your *Order ID* (starts with ORD...) and we'll check the status for you.\n\n" +
          "Thank you for your patience! 🙏"
        );
      } else if (listId === "RETURN_REQUEST") {
        userState[from].step = "support_return";
        await sendMessage(from,
          "↩️ *Return Request*\n\n" +
          "We accept returns within *7 days* of delivery.\n\n" +
          "Please share:\n• Your *Order ID*\n• *Reason* for return\n• *Photo* of the product\n\n" +
          "Send these and our team will arrange pickup for you."
        );
      } else if (listId === "REPLACEMENT") {
        userState[from].step = "support_replacement";
        await sendMessage(from,
          "🔄 *Replacement Request*\n\n" +
          "We're sorry! Please share:\n• Your *Order ID*\n• *Photo* of the damaged or wrong item\n\n" +
          "We'll arrange a replacement as soon as possible."
        );
      } else if (listId === "REFUND") {
        userState[from].step = "support_refund";
        await sendMessage(from,
          "💰 *Refund Status*\n\n" +
          "Refunds are processed within *5–7 working days* after return pickup.\n\n" +
          "Please share your *Order ID* and we'll check the status."
        );
      } else if (listId === "TALK_TO_US") {
        userState[from].step = "support_detail";
        await sendMessage(from,
          "📞 *Talk to Our Team*\n\n" +
          "Call or WhatsApp us:\n*+" + SUPPORT_PHONE + "*\n\n" +
          "_Mon–Sat: 10am – 7pm_"
        );
      }

      return res.sendStatus(200);
    }

    // ── FLOW COMPLETION (address form) ──────────────────────────────
    if (type === "interactive" && message.interactive && message.interactive.type === "nfm_reply") {
      var formData = {};
      try {
        formData = JSON.parse(message.interactive.nfm_reply && message.interactive.nfm_reply.response_json || "{}");
      } catch(e) { formData = {}; }

      console.log("Form data:", JSON.stringify(formData, null, 2));

      var full_name      = formData.full_name      || "";
      var fPhone         = formData.phone          || "";
      var fEmail         = formData.email          || "";
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

      await saveChatLog({
        phone:   from,
        message: "ADDRESS: " + fullAddress + (fEmail ? " | Email: " + fEmail : ""),
        step:    "address_submitted"
      });

      if (!userOrders[from]) userOrders[from] = { items: [] };
      userOrders[from].address = fullAddress;
      userOrders[from].email   = fEmail;

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
        await triggerPayment(from, orderId, userOrders[from].items, 0);
      }

      return res.sendStatus(200);
    }

    // ── CHAT LOG ─────────────────────────────────────────────────────
    var logMessage = (message.text && message.text.body) || type;
    if (type === "order" && message.order && message.order.product_items) {
      logMessage = message.order.product_items.map(function(p) {
        return p.product_retailer_id + " x" + p.quantity;
      }).join(", ") || "Order";
    }
    await saveChatLog({ phone: from, message: logMessage, step: userState[from].step });

    // ── GREETING / FIRST MESSAGE ─────────────────────────────────────
    var textBody   = message.text && message.text.body ? message.text.body.toLowerCase().trim() : "";
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
      var products = (message.order && message.order.product_items) || [];
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

    // ── IMAGE (support photos only — no payment screenshots needed now) ──
    if (type === "image") {
      var imgUrl  = await getMediaUrl(message.image && message.image.id);
      var curStep = userState[from].step;

      if (curStep === "support_return" || curStep === "support_replacement") {
        var supportType = curStep === "support_return" ? "Return Request" : "Replacement Request";

        await saveOrder({
          orderId:  "SUP-" + from + "-" + Date.now().toString().slice(-6),
          phone:    from,
          product:  supportType + " photo",
          price:    "",
          address:  "",
          email:    "",
          status:   supportType + " — photo received",
          txn:      imgUrl,
          raw:      JSON.stringify({ type: supportType, phone: from })
        });

        await saveChatLog({ phone: from, message: supportType + " photo: " + imgUrl, step: curStep });

        await sendMessage(from,
          "✅ *Thank you for sharing the details!*\n\n" +
          "We've received your " + (curStep === "support_return" ? "return" : "replacement") + " request.\n\n" +
          "Our team will review and get back to you within *24–48 hours*.\n\n" +
          "For urgent help: 📞 *+" + SUPPORT_PHONE + "*"
        );
      } else {
        await saveChatLog({ phone: from, message: "Image received at step: " + curStep, step: curStep });
        await sendMessage(from, "📸 Image received! If this is for a support request, please also share your Order ID.");
      }

      return res.sendStatus(200);
    }

    // ── TEXT FALLBACK ────────────────────────────────────────────────
    if (type === "text") {
      var step = userState[from].step;

      if (step === "payment") {
        await sendMessage(from,
          "📱 Please tap *Review & Pay* above to complete your payment.\n\n" +
          "If you've already paid, we'll send you a confirmation shortly. ✅"
        );

      } else if (step === "awaiting_address_flow") {
        await sendMessage(from, "📋 Please fill in the delivery form above 👆");

      } else if (step === "awaiting_promo") {
        await sendMessage(from, "👆 Please tap *Apply 10% Off* or *No Thanks* above.");

      } else if (step === "support_order_status") {
        await saveChatLog({ phone: from, message: "Order status query: " + textBody, step: step });
        await sendMessage(from, "✅ *Thank you!*\n\nWe'll check your order status and get back to you shortly 🙏");
        userState[from].step = "support_detail";

      } else if (step === "support_return" || step === "support_replacement") {
        await saveChatLog({ phone: from, message: "Support detail: " + textBody, step: step });
        await sendMessage(from,
          "✅ *Details noted!*\n\nPlease also send a *photo* of the product so we can process your request faster.\n\nOur team will get back to you within *24–48 hours* 🙏"
        );

      } else if (step === "support_refund") {
        await saveChatLog({ phone: from, message: "Refund query: " + textBody, step: step });
        await sendMessage(from, "✅ *Thank you!*\n\nWe'll check the refund status and update you shortly 🙏");
        userState[from].step = "support_detail";

      } else if (step === "support" || step === "support_detail") {
        await sendMessage(from, "Please select an option from the menu above, or describe your concern and we'll respond soon 🙏");

      } else {
        await sendMessage(from, "👉 Please select a product from catalogue to continue 🛍️");
      }

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
