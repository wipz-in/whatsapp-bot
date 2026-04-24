const express    = require("express");
const bodyParser = require("body-parser");
const axios      = require("axios");
const crypto     = require("crypto");
const cloudinary = require("cloudinary").v2;
const QRCode = require("qrcode");

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

// Raw body for /flow-endpoint
app.use((req, res, next) => {
  if (req.path === "/flow-endpoint") {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      req.rawBody = raw;
      try { req.body = JSON.parse(raw); } catch (e) { req.body = {}; }
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
const UPI_MCC                 = process.env.UPI_MCC                 || "5661";
const SUPPORT_PHONE           = process.env.SUPPORT_PHONE           || "919657748074";
const ADDRESS_FLOW_ID         = process.env.ADDRESS_FLOW_ID         || "YOUR_FLOW_ID_HERE";
const FLOW_PRIVATE_KEY        = process.env.FLOW_PRIVATE_KEY        || "";
const START_MESSAGE_VIDEO_URL = process.env.START_MESSAGE_VIDEO_URL || "YOUR_VIDEO_URL_HERE";

const userState      = {};
const userOrders     = {};
const knownCustomers = new Set();


// =========================
// WEBHOOK VERIFY
// =========================
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});


// =========================
// FLOW ENCRYPTION HELPERS
// =========================
function decryptRequest(body) {
  const decryptedAesKey = crypto.privateDecrypt(
    { key: FLOW_PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(body.encrypted_aes_key, "base64")
  );
  const flowDataBuffer = Buffer.from(body.encrypted_flow_data, "base64");
  const iv             = Buffer.from(body.initial_vector, "base64");
  const TAG_LENGTH     = 16;
  const decipher       = crypto.createDecipheriv("aes-128-gcm", decryptedAesKey, iv);
  decipher.setAuthTag(flowDataBuffer.slice(-TAG_LENGTH));
  const decrypted = decipher.update(flowDataBuffer.slice(0, -TAG_LENGTH), undefined, "utf8") + decipher.final("utf8");
  return { decryptedBody: JSON.parse(decrypted), aesKeyBuffer: decryptedAesKey, initialVectorBuffer: iv };
}

function encryptResponse(data, aesKeyBuffer, ivBuffer) {
  const flippedIV = Buffer.alloc(ivBuffer.length);
  for (let i = 0; i < ivBuffer.length; i++) flippedIV[i] = ~ivBuffer[i];
  const cipher      = crypto.createCipheriv("aes-128-gcm", aesKeyBuffer, flippedIV);
  const encrypted   = Buffer.concat([cipher.update(JSON.stringify(data), "utf-8"), cipher.final(), cipher.getAuthTag()]);
  return encrypted.toString("base64");
}


// =========================
// FLOW ENDPOINT
// =========================
app.post("/flow-endpoint", (req, res) => {
  try {
    const body = req.body;

    if (body && body.action === "ping" && !body.encrypted_aes_key) {
      return res.json({ data: { status: "active" } });
    }

    if (!body || !body.encrypted_aes_key || !body.encrypted_flow_data) {
      return res.status(421).send("Missing encryption fields");
    }

    let decryptedBody, aesKeyBuffer, initialVectorBuffer;
    try {
      const result = decryptRequest(body);
      decryptedBody        = result.decryptedBody;
      aesKeyBuffer         = result.aesKeyBuffer;
      initialVectorBuffer  = result.initialVectorBuffer;
      console.log("Flow decrypted:", JSON.stringify(decryptedBody, null, 2));
    } catch (err) {
      console.error("Decryption failed:", err.message);
      return res.status(421).send("Decryption failed");
    }

    const action     = decryptedBody.action;
    const flow_token = decryptedBody.flow_token;

    if (action === "ping") {
      return res.send(encryptResponse({ data: { status: "active" } }, aesKeyBuffer, initialVectorBuffer));
    }
    if (action === "INIT") {
      return res.send(encryptResponse({ screen: "ADDRESS", data: {} }, aesKeyBuffer, initialVectorBuffer));
    }
    if (action === "data_exchange") {
      return res.send(encryptResponse(
        { screen: "SUCCESS", data: { extension_message_response: { params: { flow_token: flow_token } } } },
        aesKeyBuffer, initialVectorBuffer
      ));
    }
    return res.send(encryptResponse({ data: { status: "ok" } }, aesKeyBuffer, initialVectorBuffer));

  } catch (err) {
    console.error("Flow endpoint error:", err.message);
    return res.status(500).send("Internal error");
  }
});


// =========================
// SAVE CHAT LOG
// =========================
async function saveChatLog(data) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Logs!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
          data.phone,
          data.message,
          data.step
        ]]
      }
    });
  } catch (err) {
    console.error("Chat log error:", err.message);
  }
}


// =========================
// SEND WELCOME TEMPLATES
// =========================
async function sendWelcomeTemplates(to) {
  // Template 1: start_message (video header)
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp",
        to: to,
        type: "template",
        template: {
          name: "start_message",
          language: { code: "en" },
          components: [
            {
              type: "header",
              parameters: [{ type: "video", video: { link: START_MESSAGE_VIDEO_URL } }]
            }
          ]
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
    console.log("start_message sent");
  } catch (err) {
    console.error("start_message error:", JSON.stringify(err.response && err.response.data, null, 2));
    await sendMessage(to, "👋 Welcome to *Wipz* 💫\n\nStylish & super-comfy Women's Footwear ✨\n🔥 Loved by 100000+ happy customers.\n_Proudly Made in Maharashtra_ 🇮🇳");
  }

  await new Promise(r => setTimeout(r, 1200));

  // Template 2: intro_catalog (catalog button)
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp",
        to: to,
        type: "template",
        template: {
          name: "intro_catalog",
          language: { code: "en" },
          components: [
            {
              type: "button",
              sub_type: "CATALOG",
              index: "0",
              parameters: [{ type: "action", action: { thumbnail_product_retailer_id: "" } }]
            }
          ]
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
    console.log("intro_catalog sent");
  } catch (err) {
    console.error("intro_catalog error:", JSON.stringify(err.response && err.response.data, null, 2));
  }
}


// =========================
// RETURNING CUSTOMER MENU
// =========================
async function sendReturningCustomerMenu(to) {
  await sendWelcomeTemplates(to);
  await new Promise(r => setTimeout(r, 1500));
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
          body: { text: "Welcome back to *Wipz*! 💖\n\nWould you like to shop again or need help with a previous order?" },
          footer: { text: "Wipz Support — Always here for you!" },
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
  } catch (err) {
    console.error("Returning menu error:", err.response && err.response.data || err.message);
  }
}


// =========================
// ORDER SUPPORT MENU
// =========================
async function sendOrderSupportMenu(to) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: "We are here to help! 🙏\n\nPlease select what you need assistance with:" },
          footer: { text: "Or call us: +" + SUPPORT_PHONE },
          action: {
            button: "Select Option",
            sections: [
              {
                title: "Order Help",
                rows: [
                  { id: "ORDER_STATUS",   title: "Order Status",    description: "Check where your order is"          },
                  { id: "RETURN_REQUEST", title: "Return Request",  description: "Return a product within 7 days"     },
                  { id: "REPLACEMENT",    title: "Replacement",     description: "Damaged or wrong item received"      },
                  { id: "REFUND",         title: "Refund Status",   description: "Check your refund progress"         },
                  { id: "OTHER_ISSUE",    title: "Other Issue",     description: "Any other concern"                  }
                ]
              }
            ]
          }
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Support menu error:", err.response && err.response.data || err.message);
  }
}


// =========================
// SEND ADDRESS FLOW
// =========================
async function sendAddressFlow(to) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "interactive",
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
    console.log("Address flow sent to", to);
  } catch (err) {
    console.error("Address flow error:", JSON.stringify(err.response && err.response.data, null, 2));
    await sendMessage(to, "📦 Please send your delivery details:\n\nName:\nPhone:\nHouse No. & Name:\nArea & Street:\nLandmark:\nCity:\nPincode:");
  }
}


// =========================
// SEND UPI PAYMENT MESSAGE
// Uses upi_intent_link with MCC for proper merchant payment
// This removes "Request Restricted" warnings from UPI apps
// =========================
async function sendUpiPaymentMessage(to, orderDetails) {
  const totalPrice   = orderDetails.totalPrice;
  const lineItems    = orderDetails.lineItems;
  const itemsSummary = orderDetails.itemsSummary;
  const orderId      = orderDetails.orderId;

  const amountInPaise = Math.round(totalPrice * 100);

const QRCode = require("qrcode");

async function sendPaymentQR(to, orderDetails) {
  const { totalPrice, itemsSummary, orderId } = orderDetails;

  // Build UPI deep link with amount pre-filled
  // Customer scans this → amount is auto-filled in their UPI app
  const upiString =
    "upi://pay?pa=" + UPI_VPA +
    "&pn=" + encodeURIComponent(UPI_NAME) +
    "&am=" + totalPrice +
    "&cu=INR" +
    "&tn=" + encodeURIComponent("Order " + orderId);

  // Generate QR as PNG buffer
  const qrBuffer = await QRCode.toBuffer(upiString, {
    type:              "png",
    width:             512,
    margin:            2,
    color: {
      dark:  "#000000",
      light: "#FFFFFF"
    }
  });

  // Upload QR image to Cloudinary
  const qrImageUrl = await uploadToCloudinary(qrBuffer);

  // Send QR image with instructions
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp",
        to: to,
        type: "image",
        image: {
          link:    qrImageUrl,
          caption:
            "💳 *Scan to Pay*\n\n" +
            itemsSummary + "\n\n" +
            "📌 *Order ID:* " + orderId + "\n" +
            "💰 *Amount: ₹" + totalPrice + "*\n\n" +
            "1️⃣ Open any UPI app (GPay, PhonePe, Paytm)\n" +
            "2️⃣ Tap *Scan QR* and scan above\n" +
            "3️⃣ Amount ₹" + totalPrice + " is pre-filled\n" +
            "4️⃣ Enter your UPI PIN and pay\n" +
            "5️⃣ *Send screenshot here after payment* 📸"
        }
      },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );

    // Also send UPI number as backup
    await new Promise(r => setTimeout(r, 800));
    await sendMessage(to,
      "Or pay directly to:\n\n" +
      "📱 *UPI ID:* " + UPI_VPA + "\n" +
      "📱 *Mobile:* +" + SUPPORT_PHONE + "\n" +
      "💰 *Amount: ₹" + totalPrice + "*\n" +
      "📝 *Note/Ref:* " + orderId + "\n\n" +
      "_After payment, send screenshot here 📸_"
    );

    console.log("QR payment message sent to", to);
    return { success: true };

  } catch (err) {
    console.error("QR send error:", err.response && err.response.data || err.message);
    return { success: false };
  }
}
  
  // Build proper UPI intent link with Merchant Category Code
  // mc (MCC) tells UPI apps this is a verified merchant — prevents "Request Restricted"
  const upiIntentLink =
    "upi://pay?pa=" + UPI_VPA +
    "&pn=" + encodeURIComponent(UPI_NAME) +
    "&mc=" + UPI_MCC +
    "&tr=" + orderId +
    "&am=" + totalPrice +
    "&cu=INR" +
    "&purpose=00" +
    "&mode=00";

  // Build items with required physical-goods fields
  const itemsWithDetails = lineItems.map(function(item) {
    return {
      retailer_id: item.retailer_id,
      name:        item.name,
      amount:      item.amount,
      quantity:    item.quantity,
      country_of_origin: "India",
      importer_name:     "Wipz Footcare Industries Pvt. Ltd.",
      importer_address:  {
        address_line1: "SR. NO. 1018, Karjat Road",
        city:          "Jamkhed, Ahilyanagar",
        zone_code:     "MH",
        postal_code:   "413201",
        country_code:  "IN"
      }
    };
  });

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "interactive",
    interactive: {
      type: "order_details",
      body: {
        text: "Here's your order summary 🛍️\n\n" + itemsSummary + "\n\nTap *Review & Pay* to complete payment via UPI ✅"
      },
      footer: { text: "Wipz — Loved by 1000+ customers 💖" },
      action: {
        name: "review_and_pay",
        parameters: {
          reference_id: orderId,
          type: "physical-goods",
          payment_settings: [
            {
              type: "upi_intent_link",
              upi_intent_link: {
                link: upiIntentLink
              }
            }
          ],
          currency: "INR",
          total_amount: { value: amountInPaise, offset: 100 },
          order: {
            status:   "pending",
            items:    itemsWithDetails,
            subtotal: { value: amountInPaise, offset: 100 },
            tax:      { value: 0, offset: 100, description: "GST Inclusive" },
            shipping: { value: 0, offset: 100, description: "Free Delivery" },
            discount: { value: 0, offset: 100, description: "" }
          }
        }
      }
    }
  };

  console.log("Payment payload:", JSON.stringify(payload, null, 2));

  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      payload,
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
    console.log("Payment message sent");
    return { success: true };
  } catch (error) {
    console.error("Payment failed:", JSON.stringify(error.response && error.response.data, null, 2));
    return { success: false };
  }
}


// =========================
// BUILD ORDER SUMMARY
// =========================
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

    lines.push("• *" + item.name + "*  ×" + item.quantity + "  — ₹" + lineTotal);
  }

  return {
    totalPrice:   totalPrice,
    lineItems:    lineItems,
    itemsSummary: lines.join("\n") + "\n\n💰 *Total: ₹" + totalPrice + "*"
  };
}


// =========================
// MAIN WEBHOOK
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const body        = req.body;
    const incomingMsg = body &&
                        body.entry &&
                        body.entry[0] &&
                        body.entry[0].changes &&
                        body.entry[0].changes[0] &&
                        body.entry[0].changes[0].value &&
                        body.entry[0].changes[0].value.messages &&
                        body.entry[0].changes[0].value.messages[0];

    if (!incomingMsg) return res.sendStatus(200);

    const from = incomingMsg.from;
    const type = incomingMsg.type;

    if (!userState[from]) {
      userState[from] = { step: "idle", seenWelcome: false, hasOrders: false };
    }

    // ── PAYMENT STATUS ──────────────────────────────────────────────
    if (type === "interactive" &&
        incomingMsg.interactive &&
        incomingMsg.interactive.type === "payment_info") {

      const pi          = incomingMsg.interactive.payment_info;
      const status      = pi && pi.payment_status;
      const referenceId = pi && pi.reference_id;
      const txnId       = pi && pi.transaction_id;
      const amount      = pi && pi.total_amount ? pi.total_amount.value / 100 : 0;

      console.log("Payment " + status + " Order:" + referenceId + " TXN:" + txnId);

      if (status === "captured") {
        knownCustomers.add(from);
        var productSummary = "";
        if (userOrders[from] && userOrders[from].items) {
          productSummary = userOrders[from].items.map(function(i) {
            return i.name + " x" + i.quantity;
          }).join(", ");
        }

        await saveOrder({
          orderId:    referenceId,
          phone:      from,
          product:    productSummary,
          price:      amount,
          address:    userOrders[from] ? userOrders[from].address || "" : "",
          status:     "PAID",
          screenshot: "UPI TXN: " + txnId,
          raw:        JSON.stringify(pi)
        });

        userState[from] = { step: "done", seenWelcome: true, hasOrders: true };

        await sendMessage(from,
          "✅ *Payment Confirmed!*\n\n" +
          "🧾 Order ID: *" + referenceId + "*\n" +
          "💰 Amount: ₹" + amount + "\n" +
          "🔖 UTR: " + txnId + "\n\n" +
          "Your order is being processed 🚚\n" +
          "We'll send shipping updates here.\n\n" +
          "💖 Thank you for shopping with *Wipz*!\n\n" +
          "For any help:\n📞 +" + SUPPORT_PHONE
        );

        await sendOrderStatusUpdate(from, referenceId, "processing");

      } else if (status === "failed") {
        await sendMessage(from, "❌ Payment failed. Please try again 👇");
        if (userOrders[from] && userOrders[from].items) {
          var s = buildOrderSummary(userOrders[from].items);
          await sendUpiPaymentMessage(from, {
            totalPrice:   s.totalPrice,
            lineItems:    s.lineItems,
            itemsSummary: s.itemsSummary,
            orderId:      referenceId
          });
        }
      }
      return res.sendStatus(200);
    }

    // ── BUTTON REPLY ────────────────────────────────────────────────
    if (type === "interactive" &&
        incomingMsg.interactive &&
        incomingMsg.interactive.type === "button_reply") {

      var btnId = incomingMsg.interactive.button_reply &&
                  incomingMsg.interactive.button_reply.id;

      if (btnId === "SHOP_AGAIN") {
        userState[from] = { step: "idle", seenWelcome: true, hasOrders: userState[from].hasOrders };
        userOrders[from] = null;
        await sendMessage(from, "😍 Let's find your next favourite pair!\n\n🛍️ Browse our catalogue and select a product 👆");

      } else if (btnId === "ORDER_SUPPORT") {
        userState[from].step = "support";
        await sendOrderSupportMenu(from);

      } else if (btnId === "CALL_SUPPORT") {
        await sendMessage(from,
          "📞 *Call or WhatsApp us directly:*\n\n+" + SUPPORT_PHONE +
          "\n\nOur team is here to help!\n_Mon–Sat: 10am – 7pm_"
        );
      }
      return res.sendStatus(200);
    }

    // ── LIST REPLY (support options) ────────────────────────────────
    if (type === "interactive" &&
        incomingMsg.interactive &&
        incomingMsg.interactive.type === "list_reply") {

      var listId = incomingMsg.interactive.list_reply &&
                   incomingMsg.interactive.list_reply.id;

      var supportMsg = {
        ORDER_STATUS:   "📦 *Order Status*\n\nPlease share your *Order ID* (starts with ORD...) and we'll check it for you.\n\nOr call us: +" + SUPPORT_PHONE,
        RETURN_REQUEST: "↩️ *Return Request*\n\nWe accept returns within *7 days* of delivery.\n\nPlease share:\n• Order ID\n• Reason for return\n• Photo of the product\n\nCall us: +" + SUPPORT_PHONE,
        REPLACEMENT:    "🔄 *Replacement Request*\n\nSorry about that! Please share:\n• Order ID\n• Photo of the damaged/wrong item\n\nWe'll arrange a replacement ASAP.\nCall us: +" + SUPPORT_PHONE,
        REFUND:         "💰 *Refund Status*\n\nRefunds are processed within *5–7 working days* after return pickup.\n\nShare your *Order ID* and we'll update you.\nCall us: +" + SUPPORT_PHONE,
        OTHER_ISSUE:    "❓ Please describe your issue and we'll respond soon.\n\nYou can also reach us:\n📞 +" + SUPPORT_PHONE + "\n_Mon–Sat: 10am – 7pm_"
      };

      await sendMessage(from, supportMsg[listId] || supportMsg["OTHER_ISSUE"]);
      userState[from].step = "support_detail";
      return res.sendStatus(200);
    }

    // ── FLOW COMPLETION (address form submitted) ────────────────────
    if (type === "interactive" &&
        incomingMsg.interactive &&
        incomingMsg.interactive.type === "nfm_reply") {

      var formData = {};
      try {
        formData = JSON.parse(
          incomingMsg.interactive.nfm_reply &&
          incomingMsg.interactive.nfm_reply.response_json || "{}"
        );
      } catch (e) {
        formData = {};
      }

      console.log("Flow form data:", JSON.stringify(formData, null, 2));

      var full_name      = formData.full_name      || "";
      var phone_         = formData.phone          || "";
      var address_line_1 = formData.address_line_1 || "";
      var address_line_2 = formData.address_line_2 || "";
      var address_line_3 = formData.address_line_3 || "";
      var city           = formData.city           || "";
      var pincode        = formData.pincode        || "";

      var fullAddress = [
        full_name,
        phone_ ? "Ph: " + phone_ : "",
        address_line_1,
        address_line_2,
        address_line_3,
        city,
        pincode
      ].filter(Boolean).join(", ");

      console.log("Address:", fullAddress);

      // Save address instantly to Logs sheet
      await saveChatLog({
        phone:   from,
        message: "ADDRESS: " + fullAddress,
        step:    "address_submitted"
      });

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

      userOrders[from].orderId = orderId;
      userState[from].step     = "payment";

      var summary = buildOrderSummary(userOrders[from].items);

      await sendMessage(from, "🎉 Almost there! Here's your order summary 👇");

      var result = await sendPaymentQR(from, {
  totalPrice:   summary.totalPrice,
  itemsSummary: summary.itemsSummary,
  orderId:      orderId
});

      if (!result.success) {
        await sendMessage(from,
          "💳 UPI ID: *" + UPI_VPA + "*\n" +
          "Amount: *₹" + summary.totalPrice + "*\n\n" +
          "Pay and send screenshot 📸"
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
    console.log("Incoming:", JSON.stringify(incomingMsg, null, 2));

    // ── GREETING / FIRST MESSAGE → welcome templates ─────────────
    var textBody  = incomingMsg.text && incomingMsg.text.body ? incomingMsg.text.body.toLowerCase().trim() : "";
    var greetings = ["hi", "hello", "start", "hey", "hii", "helo"];
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

    // ── ORDER FROM CATALOG ───────────────────────────────────────
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
            existing = userOrders[from].items[ei];
            break;
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
      var cartTotal = 0;
      for (var ci = 0; ci < allItems.length; ci++) {
        cartTotal += allItems[ci].price * allItems[ci].quantity;
      }

      var firstWithImage = null;
      for (var ii = 0; ii < allItems.length; ii++) {
        if (allItems[ii].imageUrl) { firstWithImage = allItems[ii]; break; }
      }

      if (firstWithImage) {
        try {
          await axios.post(
            "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
            {
              messaging_product: "whatsapp",
              to: from,
              type: "image",
              image: {
                link: firstWithImage.imageUrl,
                caption: allItems.map(function(i) {
                  return "🛍️ *" + i.name + "*  |  Qty: " + i.quantity + "  |  ₹" + (i.price * i.quantity);
                }).join("\n")
              }
            },
            { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
          );
        } catch (e) {
          console.error("Image send error:", e.message);
        }
      }

      var cartLines = allItems.map(function(i) {
        return "• *" + i.name + "*  ×" + i.quantity + "  — ₹" + (i.price * i.quantity);
      }).join("\n");

      await sendMessage(from, "🛒 *Your Cart:*\n\n" + cartLines + "\n\n💰 *Total: ₹" + cartTotal + "*");

      userState[from].step = "awaiting_address_flow";
      await sendAddressFlow(from);
      return res.sendStatus(200);
    }

    // ── TEXT FALLBACK ────────────────────────────────────────────
    if (type === "text") {
      var step = userState[from].step;
      if (step === "payment") {
        await sendMessage(from, "💳 Please tap *Review & Pay* above to complete your payment 👆");
      } else if (step === "awaiting_address_flow") {
        await sendMessage(from, "📋 Please fill in the delivery form above 👆");
      } else if (step === "support" || step === "support_detail") {
        await sendMessage(from, "For urgent help:\n📞 *+" + SUPPORT_PHONE + "*\n\nOr describe your issue and we'll respond soon 🙏");
      } else {
        await sendMessage(from, "👉 Please select a product from catalogue to continue 🛍️");
      }
      return res.sendStatus(200);
    }

    // ── SCREENSHOT FALLBACK ──────────────────────────────────────
    if (type === "image" && userState[from].step === "payment") {
      var imageUrl2    = await getMediaUrl(incomingMsg.image && incomingMsg.image.id);
      var orderId2     = userOrders[from] && userOrders[from].orderId || "ORD-MANUAL";
      var pSummary     = userOrders[from] && userOrders[from].items
        ? userOrders[from].items.map(function(i) { return i.name + " x" + i.quantity; }).join(", ")
        : "";
      var totalPrice2  = userOrders[from] && userOrders[from].items
        ? userOrders[from].items.reduce(function(s, i) { return s + i.price * i.quantity; }, 0)
        : 0;

      userOrders[from].status = "payment_screenshot_sent";
      userState[from].step    = "done";
      knownCustomers.add(from);

      await saveOrder({
        orderId:    orderId2,
        phone:      from,
        product:    pSummary,
        price:      totalPrice2,
        address:    userOrders[from].address || "",
        status:     "Screenshot received - verify needed",
        screenshot: imageUrl2,
        raw:        JSON.stringify(userOrders[from])
      });

      await sendMessage(from,
        "✅ Screenshot received!\n\n🧾 Order ID: " + orderId2 +
        "\n\nWe'll verify and process your order shortly 🚚\n\n" +
        "💖 Thank you for shopping with *Wipz*!\n\nFor help: 📞 +" + SUPPORT_PHONE
      );
      return res.sendStatus(200);
    }

    res.sendStatus(200);

  } catch (err) {
    console.error("Webhook error:", err.response && err.response.data || err.message);
    res.sendStatus(500);
  }
});


// =========================
// ORDER STATUS UPDATE
// =========================
async function sendOrderStatusUpdate(to, referenceId, status) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
          type: "order_status",
          body: {
            text: status === "processing"
              ? "✅ Payment received! Your order is being processed."
              : "📦 Order status: " + status
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
  } catch (err) {
    console.error("Order status error:", err.response && err.response.data || err.message);
  }
}


async function getMediaUrl(mediaId) {
  try {
    var r1 = await axios.get(
      "https://graph.facebook.com/v25.0/" + mediaId,
      { headers: { Authorization: "Bearer " + TOKEN } }
    );
    var r2 = await axios.get(r1.data.url, {
      headers: { Authorization: "Bearer " + TOKEN },
      responseType: "arraybuffer"
    });
    return await uploadToCloudinary(r2.data);
  } catch (e) {
    console.error("Media error:", e.response && e.response.data || e.message);
    return null;
  }
}

async function uploadToCloudinary(buf) {
  return new Promise(function(resolve, reject) {
    cloudinary.uploader.upload_stream(
      { folder: "whatsapp_orders" },
      function(err, result) {
        if (err) reject(err);
        else resolve(result.secure_url);
      }
    ).end(buf);
  });
}

async function sendMessage(to, text) {
  try {
    await axios.post(
      "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages",
      { messaging_product: "whatsapp", to: to, type: "text", text: { body: text } },
      { headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Send error:", e.response && e.response.data || e.message);
  }
}

async function saveOrder(data) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          data.orderId    || "",
          new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
          data.phone      || "",
          data.product    || "",
          data.price      || "",
          data.address    || "",
          data.status     || "",
          data.screenshot || "",
          data.raw        || ""
        ]]
      }
    });
    console.log("Order saved");
  } catch (e) {
    console.error("Sheet error:", e.message);
  }
}

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Server running on port " + PORT);
});
