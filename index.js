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

const VERIFY_TOKEN        = "my_verify_token";
const PHONE_ID            = process.env.PHONE_NUMBER_ID;
const TOKEN               = process.env.ACCESS_TOKEN;
const UPI_VPA             = process.env.UPI_VPA             || "pktambe@upi";
const UPI_NAME            = process.env.UPI_NAME            || "Wipz";
const PAYMENT_CONFIG_NAME = "whatsapp_orders_pay";
const ADDRESS_FLOW_ID     = process.env.ADDRESS_FLOW_ID     || "YOUR_FLOW_ID_HERE";
const FLOW_PRIVATE_KEY    = process.env.FLOW_PRIVATE_KEY    || "";
const SUPPORT_PHONE       = process.env.SUPPORT_PHONE       || "919657748074";
const START_MESSAGE_VIDEO_URL = process.env.START_MESSAGE_VIDEO_URL || "YOUR_VIDEO_URL_HERE";

const userState     = {};
const userOrders    = {};
const knownCustomers = new Set();

app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

function decryptRequest(body) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;
  const decryptedAesKey = crypto.privateDecrypt(
    { key: FLOW_PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(encrypted_aes_key, "base64")
  );
  const flowDataBuffer = Buffer.from(encrypted_flow_data, "base64");
  const iv             = Buffer.from(initial_vector, "base64");
  const TAG_LENGTH     = 16;
  const encryptedData  = flowDataBuffer.slice(0, -TAG_LENGTH);
  const authTag        = flowDataBuffer.slice(-TAG_LENGTH);
  const decipher = crypto.createDecipheriv("aes-128-gcm", decryptedAesKey, iv);
  decipher.setAuthTag(authTag);
  const decryptedData = decipher.update(encryptedData, undefined, "utf8") + decipher.final("utf8");
  return { decryptedBody: JSON.parse(decryptedData), aesKeyBuffer: decryptedAesKey, initialVectorBuffer: iv };
}

function encryptResponse(responseData, aesKeyBuffer, ivBuffer) {
  const flippedIV = Buffer.alloc(ivBuffer.length);
  for (let i = 0; i < ivBuffer.length; i++) flippedIV[i] = ~ivBuffer[i];
  const cipher = crypto.createCipheriv("aes-128-gcm", aesKeyBuffer, flippedIV);
  const encryptedData = Buffer.concat([cipher.update(JSON.stringify(responseData), "utf-8"), cipher.final(), cipher.getAuthTag()]);
  return encryptedData.toString("base64");
}

app.post("/flow-endpoint", async (req, res) => {
  try {
    const body = req.body;
    if (body?.action === "ping" && !body.encrypted_aes_key) return res.json({ data: { status: "active" } });
    if (!body.encrypted_aes_key || !body.encrypted_flow_data) return res.status(421).send("Missing encryption fields");
    let decryptedBody, aesKeyBuffer, initialVectorBuffer;
    try {
      ({ decryptedBody, aesKeyBuffer, initialVectorBuffer } = decryptRequest(body));
      console.log("Flow decrypted:", JSON.stringify(decryptedBody, null, 2));
    } catch (err) {
      console.error("Decryption failed:", err.message);
      return res.status(421).send("Decryption failed");
    }
    const { action, flow_token } = decryptedBody;
    if (action === "ping")          return res.send(encryptResponse({ data: { status: "active" } }, aesKeyBuffer, initialVectorBuffer));
    if (action === "INIT")          return res.send(encryptResponse({ screen: "ADDRESS", data: {} }, aesKeyBuffer, initialVectorBuffer));
    if (action === "data_exchange") return res.send(encryptResponse({ screen: "SUCCESS", data: { extension_message_response: { params: { flow_token } } } }, aesKeyBuffer, initialVectorBuffer));
    return res.send(encryptResponse({ data: { status: "ok" } }, aesKeyBuffer, initialVectorBuffer));
  } catch (err) {
    console.error("Flow endpoint error:", err.message);
    return res.status(500).send("Internal error");
  }
});

async function saveChatLog(data) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: "Logs!A:D", valueInputOption: "USER_ENTERED",
      requestBody: { values: [[new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), data.phone, data.message, data.step]] }
    });
  } catch (err) { console.error("Chat log error:", err.message); }
}

async function sendWelcomeTemplates(to) {
  // Template 1: start_message (video header)
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      messaging_product: "whatsapp", to, type: "template",
      template: {
        name: "start_message", language: { code: "en" },
        components: [{ type: "header", parameters: [{ type: "video", video: { link: START_MESSAGE_VIDEO_URL } }] }]
      }
    }, { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
    console.log("start_message sent");
  } catch (err) {
    console.error("start_message error:", JSON.stringify(err.response?.data, null, 2));
    await sendMessage(to, "👋 Welcome to *Wipz* 💫\n\nStylish & super-comfy Women's Footwear ✨\n🔥 Loved by 1000+ happy customers.\n_Proudly Made in Maharashtra_ 🇮🇳");
  }
  await new Promise(r => setTimeout(r, 1200));
  // Template 2: intro_catalog (catalog button)
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      messaging_product: "whatsapp", to, type: "template",
      template: {
        name: "intro_catalog", language: { code: "en" },
        components: [{ type: "button", sub_type: "CATALOG", index: "0", parameters: [{ type: "action", action: { thumbnail_product_retailer_id: "" } }] }]
      }
    }, { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
    console.log("intro_catalog sent");
  } catch (err) {
    console.error("intro_catalog error:", JSON.stringify(err.response?.data, null, 2));
  }
}

async function sendReturningCustomerMenu(to) {
  await sendWelcomeTemplates(to);
  await new Promise(r => setTimeout(r, 1500));
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Welcome back to *Wipz*! 💖\n\nWould you like to shop again or need help with a previous order?" },
        footer: { text: "Wipz Support — Always here for you!" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "SHOP_AGAIN",     title: "🛍️ Shop Again"    } },
            { type: "reply", reply: { id: "ORDER_SUPPORT",  title: "📦 Order Support"  } },
            { type: "reply", reply: { id: "CALL_SUPPORT",   title: "📞 Call Us"        } }
          ]
        }
      }
    }, { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
    console.log("Returning customer menu sent");
  } catch (err) { console.error("Returning menu error:", err.response?.data || err.message); }
}

async function sendOrderSupportMenu(to) {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive",
      interactive: {
        type: "list",
        body: { text: "We're here to help! 🙏\n\nPlease select what you need assistance with:" },
        footer: { text: `Or call us: +${SUPPORT_PHONE}` },
        action: {
          button: "Select Option",
          sections: [{
            title: "Order Help",
            rows: [
              { id: "ORDER_STATUS",   title: "📦 Order Status",      description: "Check where your order is"           },
              { id: "RETURN_REQUEST", title: "↩️ Return Request",    description: "Return a product within 7 days"      },
              { id: "REPLACEMENT",    title: "🔄 Replacement",       description: "Damaged or wrong item received"       },
              { id: "REFUND",         title: "💰 Refund Status",     description: "Check your refund progress"          },
              { id: "OTHER_ISSUE",    title: "❓ Other Issue",       description: "Any other concern"                   }
            ]
          }]
        }
      }
    }, { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
  } catch (err) { console.error("Support menu error:", err.response?.data || err.message); }
}

async function sendAddressFlow(to) {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive",
      interactive: {
        type: "flow",
        header: { type: "text", text: "📦 Delivery Details" },
        body:   { text: "Please fill in your delivery address so we can ship your order 🚚" },
        footer: { text: "Wipz — Fast & Secure Delivery 💖" },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token: `ADDR_${to}_${Date.now()}`,
            flow_id: ADDRESS_FLOW_ID,
            flow_cta: "Enter Delivery Address",
            flow_action: "navigate",
            flow_action_payload: { screen: "ADDRESS" }
          }
        }
      }
    }, { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
    console.log("Address flow sent");
  } catch (err) {
    console.error("Address flow error:", JSON.stringify(err.response?.data, null, 2));
    await sendMessage(to, "📦 Please send your delivery details:\n\nName:\nPhone:\nHouse No. & Name:\nArea & Street:\nLandmark:\nCity:\nPincode:");
  }
}

async function sendUpiPaymentMessage(to, orderDetails) {
  const { totalPrice, lineItems, itemsSummary, orderId } = orderDetails;
  const amountInPaise = Math.round(totalPrice * 100);
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      messaging_product: "whatsapp", recipient_type: "individual", to, type: "interactive",
      interactive: {
        type: "order_details",
        body:   { text: `Here's your order summary 🛍️\n\n${itemsSummary}\n\nTap *Review & Pay* to complete payment via UPI ✅` },
        footer: { text: "Wipz — Loved by 1000+ customers 💖" },
        action: {
          name: "review_and_pay",
          parameters: {
            reference_id: orderId, type: "digital-goods",
            payment_type: "upi", payment_configuration: PAYMENT_CONFIG_NAME,
            currency: "INR", total_amount: { value: amountInPaise, offset: 100 },
            order: {
              status: "pending", items: lineItems,
              subtotal: { value: amountInPaise, offset: 100 },
              tax:      { value: 0, offset: 100, description: "GST Inclusive" },
              shipping: { value: 0, offset: 100, description: "Free Delivery" },
              discount: { value: 0, offset: 100, description: "" }
            }
          }
        }
      }
    }, { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
    console.log("Payment message sent");
    return { success: true };
  } catch (error) {
    console.error("Payment failed:", JSON.stringify(error.response?.data, null, 2));
    return { success: false };
  }
}

function buildOrderSummary(items) {
  let totalPrice = 0;
  const lineItems = [], lines = [];
  for (const item of items) {
    const lineTotal = item.price * item.quantity;
    totalPrice += lineTotal;
    lineItems.push({ retailer_id: String(item.retailer_id), name: item.name, amount: { value: Math.round(item.price * 100), offset: 100 }, quantity: item.quantity });
    lines.push(`• *${item.name}*  ×${item.quantity}  — ₹${lineTotal}`);
  }
  return { totalPrice, lineItems, itemsSummary: lines.join("\n") + `\n\n💰 *Total: ₹${totalPrice}*` };
}

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    const incomingMsg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    // PAYMENT STATUS
    if (incomingMsg?.type === "interactive" && incomingMsg?.interactive?.type === "payment_info") {
      const from = incomingMsg.from;
      const pi   = incomingMsg.interactive.payment_info;
      const status = pi?.payment_status, referenceId = pi?.reference_id, txnId = pi?.transaction_id;
      const amount = (pi?.total_amount?.value || 0) / 100;
      if (status === "captured") {
        knownCustomers.add(from);
        const productSummary = (userOrders[from]?.items || []).map(i => `${i.name} ×${i.quantity}`).join(", ");
        await saveOrder({ orderId: referenceId, phone: from, product: productSummary, price: amount, address: userOrders[from]?.address || "", status: "PAID ✅", screenshot: `UPI TXN: ${txnId}`, raw: JSON.stringify(pi) });
        userState[from] = { step: "done", seenWelcome: true, hasOrders: true };
        await sendMessage(from, `✅ *Payment Confirmed!*\n\n🧾 Order ID: *${referenceId}*\n💰 Amount: ₹${amount}\n🔖 UTR: ${txnId}\n\nYour order is being processed 🚚\nWe'll send shipping updates here.\n\n💖 Thank you for shopping with *Wipz*!\n\nFor any help, call or WhatsApp:\n📞 +${SUPPORT_PHONE}`);
        await sendOrderStatusUpdate(from, referenceId, "processing");
      } else if (status === "failed") {
        await sendMessage(from, "❌ Payment failed. Please try again 👇");
        if (userOrders[from]) { const s = buildOrderSummary(userOrders[from].items || []); await sendUpiPaymentMessage(from, { ...s, orderId: referenceId }); }
      }
      return res.sendStatus(200);
    }

    // BUTTON REPLY
    if (incomingMsg?.type === "interactive" && incomingMsg?.interactive?.type === "button_reply") {
      const from  = incomingMsg.from;
      const btnId = incomingMsg.interactive.button_reply?.id;
      if (btnId === "SHOP_AGAIN") {
        userState[from] = { step: "idle", seenWelcome: true, hasOrders: userState[from]?.hasOrders };
        userOrders[from] = null;
        await sendMessage(from, "😍 Let's find your next favourite pair!\n\n🛍️ Browse our catalogue and select a product 👆");
      } else if (btnId === "ORDER_SUPPORT") {
        userState[from].step = "support";
        await sendOrderSupportMenu(from);
      } else if (btnId === "CALL_SUPPORT") {
        await sendMessage(from, `📞 *Call or WhatsApp us directly:*\n\n+${SUPPORT_PHONE}\n\nOur team is here to help!\n_Mon–Sat: 10am – 7pm_`);
      }
      return res.sendStatus(200);
    }

    // LIST REPLY (support options)
    if (incomingMsg?.type === "interactive" && incomingMsg?.interactive?.type === "list_reply") {
      const from   = incomingMsg.from;
      const listId = incomingMsg.interactive.list_reply?.id;
      const msgs = {
        ORDER_STATUS:   `📦 *Order Status*\n\nPlease share your *Order ID* (starts with ORD...) and we'll check it for you.\n\nOr call us: +${SUPPORT_PHONE}`,
        RETURN_REQUEST: `↩️ *Return Request*\n\nWe accept returns within *7 days* of delivery.\n\nPlease share:\n• Order ID\n• Reason for return\n• Photo of the product\n\nCall us: +${SUPPORT_PHONE}`,
        REPLACEMENT:    `🔄 *Replacement Request*\n\nSorry about that! Please share:\n• Order ID\n• Photo of the damaged/wrong item\n\nWe'll arrange a replacement ASAP.\nCall us: +${SUPPORT_PHONE}`,
        REFUND:         `💰 *Refund Status*\n\nRefunds are processed within *5–7 working days* after return pickup.\n\nShare your *Order ID* and we'll update you.\nCall us: +${SUPPORT_PHONE}`,
        OTHER_ISSUE:    `❓ Please describe your issue and we'll respond soon.\n\nYou can also reach us directly:\n📞 +${SUPPORT_PHONE}\n_Mon–Sat: 10am – 7pm_`
      };
      await sendMessage(from, msgs[listId] || msgs["OTHER_ISSUE"]);
      userState[from].step = "support_detail";
      return res.sendStatus(200);
    }

    // FLOW COMPLETION
    if (incomingMsg?.type === "interactive" && incomingMsg?.interactive?.type === "nfm_reply") {
      const from = incomingMsg.from;
      let formData = {};
      try { formData = JSON.parse(incomingMsg.interactive.nfm_reply?.response_json || "{}"); } catch {}
      console.log("Form data:", JSON.stringify(formData, null, 2));
      const fullAddress = [
        formData.full_name      || "",
        formData.phone          ? `Ph: ${formData.phone}` : "",
        formData.address_line_1 || "",
        formData.address_line_2 || "",
        formData.address_line_3 || "",
        formData.city           || "",
        formData.pincode        || ""
      ].filter(Boolean).join(", ");
      console.log("Address:", fullAddress);
      if (!userOrders[from]) userOrders[from] = { items: [] };
      userOrders[from].address = fullAddress;
      if (!userOrders[from].items || userOrders[from].items.length === 0) {
        await sendMessage(from, "👉 Please select a product from catalogue first 🛍️");
        return res.sendStatus(200);
      }
      const now = new Date();
      const orderId = "ORD" + now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }).replace(/\//g, "") + "-" + now.getTime().toString().slice(-5);
      userOrders[from].orderId = orderId;
      userState[from].step = "payment";
      const summary = buildOrderSummary(userOrders[from].items);
      await sendMessage(from, "🎉 Almost there! Here's your order summary 👇");
      const result = await sendUpiPaymentMessage(from, { ...summary, orderId });
      if (!result.success) await sendMessage(from, `💳 UPI ID: *${UPI_VPA}*\nAmount: *₹${summary.totalPrice}*\n\nPay and send screenshot 📸`);
      return res.sendStatus(200);
    }

    // NORMAL MESSAGES
    const message = incomingMsg;
    if (!message) return res.sendStatus(200);
    const from = message.from, type = message.type;
    if (!userState[from]) userState[from] = { step: "idle", seenWelcome: false, hasOrders: false };

    let logMessage = message.text?.body || type;
    if (type === "order") logMessage = (message.order?.product_items || []).map(p => `${p.product_retailer_id} x${p.quantity}`).join(", ") || "Order";
    await saveChatLog({ phone: from, message: logMessage, step: userState[from]?.step });
    console.log("Incoming:", JSON.stringify(message, null, 2));

    // GREETING / FIRST MESSAGE → welcome templates
    const isGreeting = type === "text" && ["hi","hello","start","hey","hii","helo"].includes(message.text?.body?.toLowerCase().trim());
    if (!userState[from].seenWelcome || isGreeting) {
      userState[from].seenWelcome = true;
      const isReturning = knownCustomers.has(from) || userState[from].hasOrders;
      if (isReturning) {
        userState[from] = { step: "idle", seenWelcome: true, hasOrders: true };
        userOrders[from] = null;
        await sendReturningCustomerMenu(from);
      } else {
        userState[from].step = "idle";
        userOrders[from] = null;
        await sendWelcomeTemplates(from);
      }
      if (type !== "order") return res.sendStatus(200);
    }

    // ORDER FROM CATALOG
    if (type === "order") {
      const products = message.order?.product_items || [];
      if (products.length === 0) return res.sendStatus(200);
      if (!userOrders[from] || userState[from].step === "done") { userOrders[from] = { items: [] }; userState[from].step = "idle"; }
      for (const p of products) {
        const existing = userOrders[from].items?.find(i => i.retailer_id === p.product_retailer_id);
        if (existing) { existing.quantity += (p.quantity || 1); }
        else { if (!userOrders[from].items) userOrders[from].items = []; userOrders[from].items.push({ retailer_id: p.product_retailer_id, name: p.product_retailer_id, price: p.item_price || 0, quantity: p.quantity || 1, imageUrl: p.image?.link || null }); }
      }
      const allItems = userOrders[from].items, cartTotal = allItems.reduce((s, i) => s + i.price * i.quantity, 0);
      const firstWithImage = allItems.find(i => i.imageUrl);
      if (firstWithImage) {
        await axios.post(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
          messaging_product: "whatsapp", to: from, type: "image",
          image: { link: firstWithImage.imageUrl, caption: allItems.map(i => `🛍️ *${i.name}*  |  Qty: ${i.quantity}  |  ₹${i.price * i.quantity}`).join("\n") }
        }, { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
      }
      await sendMessage(from, `🛒 *Your Cart:*\n\n${allItems.map(i => `• *${i.name}*  ×${i.quantity}  — ₹${i.price * i.quantity}`).join("\n")}\n\n💰 *Total: ₹${cartTotal}*`);
      userState[from].step = "awaiting_address_flow";
      await sendAddressFlow(from);
      return res.sendStatus(200);
    }

    // TEXT FALLBACK
    if (type === "text") {
      const step = userState[from]?.step;
      if (step === "payment")              await sendMessage(from, "💳 Please tap *Review & Pay* above to complete your payment 👆");
      else if (step === "awaiting_address_flow") await sendMessage(from, "📋 Please fill in the delivery form above 👆");
      else if (step === "support" || step === "support_detail") await sendMessage(from, `For urgent help:\n📞 *+${SUPPORT_PHONE}*\n\nOr describe your issue and we'll respond soon 🙏`);
      else await sendMessage(from, "👉 Please select a product from catalogue to continue 🛍️");
      return res.sendStatus(200);
    }

    // SCREENSHOT FALLBACK
    if (type === "image" && userState[from]?.step === "payment") {
      const imageUrl = await getMediaUrl(message.image.id);
      userOrders[from].status = "payment_screenshot_sent";
      userState[from].step = "done";
      knownCustomers.add(from);
      const orderId = userOrders[from].orderId || "ORD-MANUAL";
      const productSummary = (userOrders[from].items || []).map(i => `${i.name} ×${i.quantity}`).join(", ");
      const totalPrice = (userOrders[from].items || []).reduce((s, i) => s + i.price * i.quantity, 0);
      await saveOrder({ orderId, phone: from, product: productSummary, price: totalPrice, address: userOrders[from].address || "", status: "Screenshot received ⚠️", screenshot: imageUrl, raw: JSON.stringify(userOrders[from]) });
      await sendMessage(from, `✅ Screenshot received!\n\n🧾 Order ID: ${orderId}\n\nWe'll verify and process your order shortly 🚚\n\n💖 Thank you for shopping with *Wipz*!\n\nFor help: 📞 +${SUPPORT_PHONE}`);
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

async function sendOrderStatusUpdate(to, referenceId, status) {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`, {
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: { type: "order_status", body: { text: status === "processing" ? "✅ Payment received! Your order is being processed." : `📦 Order status: ${status}` }, action: { name: "shipment_update", parameters: { reference_id: referenceId, order_status: status } } }
    }, { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
  } catch (err) { console.error("Order status error:", err.response?.data || err.message); }
}

async function getMediaUrl(mediaId) {
  try {
    const r1 = await axios.get(`https://graph.facebook.com/v25.0/${mediaId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const r2 = await axios.get(r1.data.url, { headers: { Authorization: `Bearer ${TOKEN}` }, responseType: "arraybuffer" });
    return await uploadToCloudinary(r2.data);
  } catch (e) { console.error("Media error:", e.response?.data || e.message); return null; }
}

async function uploadToCloudinary(buf) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream({ folder: "whatsapp_orders" }, (err, result) => err ? reject(err) : resolve(result.secure_url)).end(buf);
  });
}

async function sendMessage(to, text) {
  try {
    await axios.post(`https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } });
  } catch (e) { console.error("Send error:", e.response?.data || e.message); }
}

async function saveOrder(data) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: "Sheet1", valueInputOption: "USER_ENTERED",
      requestBody: { values: [[data.orderId || "", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), data.phone || "", data.product || "", data.price || "", data.address || "", data.status || "", data.screenshot || "", data.raw || ""]] }
    });
    console.log("Order saved");
  } catch (e) { console.error("Sheet error:", e.message); }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
