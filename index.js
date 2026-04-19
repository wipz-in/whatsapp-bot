const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cloudinary = require("cloudinary").v2;
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
const { google } = require("googleapis");

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const SHEET_ID = "1eC8M6-9OpGlZ0G9r64i__sWoSW3o0hzxUp97Po4bJSk";

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN        = "my_verify_token";
const PHONE_ID            = process.env.PHONE_NUMBER_ID;
const TOKEN               = process.env.ACCESS_TOKEN;
const UPI_VPA             = process.env.UPI_VPA  || "9657748074-3@ibl";
const UPI_NAME            = process.env.UPI_NAME || "Wipz";
const PAYMENT_CONFIG_NAME = "whatsapp_orders";

// 🧠 In-memory state
// userState[phone]  = { step, seenWelcome }
// userOrders[phone] = { items: [...], address, orderId, status }
const userState  = {};
const userOrders = {};


// =========================
// ✅ WEBHOOK VERIFY
// =========================
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});


// =========================
// 📝 SAVE CHAT LOG
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
// 🎬 SEND WELCOME TEMPLATES
// Sends start_message first, then intro_catalog (with catalog button)
// Templates are sent as-is — WhatsApp pulls image/video from template itself
// =========================
async function sendWelcomeTemplates(to) {
  // ── Template 1: start_message (text + image header, no button) ──
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "template",
        template: {
          name: "start_message",
          language: { code: "en" }
          // No components needed — template uses its own image header
          // If your template has variable placeholders like {{1}},
          // add them here:
          // components: [{ type: "body", parameters: [{ type: "text", text: "Wipz" }] }]
        }
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("✅ start_message template sent");
  } catch (err) {
    console.error("start_message template error:", err.response?.data || err.message);
  }

  // Small delay so messages arrive in order
  await new Promise(r => setTimeout(r, 1000));

  // ── Template 2: intro_catalog (has View Catalogue button) ──
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "template",
        template: {
          name: "intro_catalog",
          language: { code: "en" }
          // WhatsApp automatically renders the View Catalogue button
          // from the template definition — no extra config needed here
        }
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("✅ intro_catalog template sent");
  } catch (err) {
    console.error("intro_catalog template error:", err.response?.data || err.message);
  }
}


// =========================
// 💳 SEND NATIVE WHATSAPP PAYMENT MESSAGE
// payment_type "upi" + named config = shows Review & Pay button
// =========================
async function sendUpiPaymentMessage(to, orderDetails) {
  const { totalPrice, itemsSummary, orderId } = orderDetails;
  const amountInPaise = Math.round(totalPrice * 100);

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "interactive",
    interactive: {
      type: "order_details",
      body: {
        text: `Here's your order summary 🛍️\n\n${itemsSummary}\n\nTap *Review & Pay* to complete payment via UPI ✅`
      },
      footer: {
        text: "Wipz — Loved by 1000+ customers 💖"
      },
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
            items: orderDetails.lineItems,   // array built from cart
            subtotal:  { value: amountInPaise, offset: 100 },
            tax:       { value: 0, offset: 100, description: "GST Inclusive" },
            shipping:  { value: 0, offset: 100, description: "Free Delivery" },
            discount:  { value: 0, offset: 100, description: "" }
          }
        }
      }
    }
  };

  console.log("📤 Payment payload:", JSON.stringify(payload, null, 2));

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
    console.log("✅ Payment message sent:", response.data);
    return { success: true };
  } catch (error) {
    const errData = error.response?.data;
    console.error("❌ Payment message failed:", JSON.stringify(errData, null, 2));
    return { success: false, error: errData };
  }
}


// =========================
// 🛒 BUILD ORDER SUMMARY FROM CART
// Handles multiple products/variants/quantities
// =========================
function buildOrderSummary(items) {
  // items = [{ name, price, quantity, retailer_id, imageUrl }]

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

    lines.push(`• *${item.name}*  x${item.quantity}  — ₹${lineTotal}`);
  }

  const itemsSummary = lines.join("\n") + `\n\n💰 *Total: ₹${totalPrice}*`;

  return { totalPrice, lineItems, itemsSummary };
}


// =========================
// 🚀 MAIN WEBHOOK
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // ─────────────────────────────────────────────
    // ✅ PAYMENT STATUS CALLBACK FROM META
    // ─────────────────────────────────────────────
    const incomingMsg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (
      incomingMsg?.type === "interactive" &&
      incomingMsg?.interactive?.type === "payment_info"
    ) {
      const from        = incomingMsg.from;
      const paymentInfo = incomingMsg.interactive.payment_info;
      const status      = paymentInfo?.payment_status;
      const referenceId = paymentInfo?.reference_id;
      const txnId       = paymentInfo?.transaction_id;
      const amount      = (paymentInfo?.total_amount?.value || 0) / 100;

      console.log(`💰 Payment [${status}] — Order: ${referenceId}, TXN: ${txnId}`);

      if (status === "captured") {
        if (userOrders[from]) {
          userOrders[from].status        = "paid";
          userOrders[from].transactionId = txnId;
        }

        const productSummary = (userOrders[from]?.items || [])
          .map(i => `${i.name} x${i.quantity}`)
          .join(", ");

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

        await sendMessage(
          from,
          `✅ *Payment Confirmed!*\n\n🧾 Order ID: *${referenceId}*\n💰 Amount Paid: ₹${amount}\n🔖 UTR/TXN ID: ${txnId}\n\nYour order is being processed 🚚\nShipping updates coming soon!\n\n💖 Thank you for shopping with *Wipz*!`
        );
        await sendOrderStatusUpdate(from, referenceId, "processing");

      } else if (status === "failed") {
        await sendMessage(from, `❌ Payment failed for Order *${referenceId}*. Please try again 👇`);
        if (userOrders[from]) {
          const { totalPrice, lineItems, itemsSummary } = buildOrderSummary(userOrders[from].items || []);
          await sendUpiPaymentMessage(from, { totalPrice, lineItems, itemsSummary, orderId: referenceId });
        }
      }
      return res.sendStatus(200);
    }

    // ─────────────────────────────────────────────
    // Normal message flow
    // ─────────────────────────────────────────────
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const type = message.type;

    // Init user if first time
    if (!userState[from]) {
      userState[from] = { step: "idle", seenWelcome: false };
    }

    // Log
    let logMessage = message.text?.body || type;
    if (type === "order") {
      logMessage = (message.order?.product_items || [])
        .map(p => `${p.product_retailer_id} x${p.quantity}`)
        .join(", ") || "Order placed";
    }
    await saveChatLog({ phone: from, message: logMessage, step: userState[from]?.step || "new" });
    console.log("Incoming:", JSON.stringify(message, null, 2));

    // ─────────────────────────────────────────────
    // 🎬 FIRST-TIME VISITOR — send welcome templates
    // Triggers for ANY first message: hi, text, or
    // even a direct click from ad/link
    // ─────────────────────────────────────────────
    if (!userState[from].seenWelcome) {
      userState[from].seenWelcome = true;
      userState[from].step        = "idle";
      await sendWelcomeTemplates(from);
      // After welcome, if they also sent an order, keep processing below
      // If they just said "hi" or anything else, we're done for now
      if (type !== "order") return res.sendStatus(200);
    }

    // ─────────────────────────────────────────────
    // 🛍️ ORDER FROM CATALOG
    // Supports multiple items / variants / quantities
    // ─────────────────────────────────────────────
    if (type === "order") {
      const products = message.order?.product_items || [];

      if (products.length === 0) return res.sendStatus(200);

      // Build cart — merge duplicate retailer_ids (same product added twice)
      const cart = {};
      for (const p of products) {
        const key = p.product_retailer_id;
        if (cart[key]) {
          cart[key].quantity += (p.quantity || 1);
        } else {
          cart[key] = {
            retailer_id: p.product_retailer_id,
            name:        p.product_retailer_id,   // catalog sends retailer_id as name
            price:       p.item_price || 0,
            quantity:    p.quantity || 1,
            imageUrl:    p.image?.link || null
          };
        }
      }

      const items = Object.values(cart);

      // ✅ Save full cart to userOrders
      if (!userOrders[from]) {
        userOrders[from] = { items: [], status: "product_selected" };
      }

      // If they're adding more items (browsing), append; otherwise replace
      if (userState[from].step === "address" || userState[from].step === "payment") {
        // Already past selection — treat as new order, reset
        userOrders[from] = { items, status: "product_selected" };
        userState[from].step = "idle";
      } else {
        // Merge into existing cart
        for (const newItem of items) {
          const existing = userOrders[from].items.find(i => i.retailer_id === newItem.retailer_id);
          if (existing) {
            existing.quantity += newItem.quantity;
          } else {
            userOrders[from].items.push(newItem);
          }
        }
        userOrders[from].status = "product_selected";
      }

      const allItems = userOrders[from].items;

      // Send image of the first (or only) product
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
              caption: allItems.map(i => `🛍️ *${i.name}*  |  Qty: ${i.quantity}  |  ₹${i.price * i.quantity}`).join("\n")
            }
          },
          { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
        );
      }

      // Show full cart summary
      const cartLines = allItems.map(
        i => `• *${i.name}*  ×${i.quantity}  — ₹${i.price * i.quantity}`
      ).join("\n");

      const cartTotal = allItems.reduce((sum, i) => sum + i.price * i.quantity, 0);

      userState[from].step = "address";

      await sendMessage(
        from,
        `🛒 *Your Cart:*\n\n${cartLines}\n\n💰 *Total: ₹${cartTotal}*\n\n━━━━━━━━━━━━━━\nPlease send your delivery details:\n\nName:\nAddress:\nCity:\nPincode:\n📦`
      );

      return res.sendStatus(200);
    }

    // ─────────────────────────────────────────────
    // 📦 ADDRESS → GENERATE ORDER + SEND PAYMENT
    // ─────────────────────────────────────────────
    if (type === "text" && userState[from]?.step === "address") {
      const address = message.text.body;

      if (!userOrders[from] || userOrders[from].items.length === 0) {
        await sendMessage(from, "👉 Please select a product from catalogue first 🛍️");
        return res.sendStatus(200);
      }

      userOrders[from].address = address;
      userOrders[from].status  = "address_received";

      const now     = new Date();
      const orderId =
        "ORD" +
        now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }).replace(/\//g, "") +
        "-" +
        now.getTime().toString().slice(-5);

      userOrders[from].orderId = orderId;
      userState[from].step     = "payment";

      const { totalPrice, lineItems, itemsSummary } = buildOrderSummary(userOrders[from].items);

      await sendMessage(from, "🎉 Almost there! Here's your order summary with payment 👇");

      const result = await sendUpiPaymentMessage(from, {
        totalPrice,
        lineItems,
        itemsSummary,
        orderId
      });

      if (!result.success) {
        console.error("⚠️ Payment button failed:", JSON.stringify(result.error));
        await sendMessage(
          from,
          `💳 UPI ID: *${UPI_VPA}*\nAmount: *₹${totalPrice}*\nName: ${UPI_NAME}\n\nPay and send screenshot 📸`
        );
      }

      return res.sendStatus(200);
    }

    // ─────────────────────────────────────────────
    // 📸 MANUAL SCREENSHOT FALLBACK
    // ─────────────────────────────────────────────
    if (type === "image" && userState[from]?.step === "payment") {
      const mediaId  = message.image.id;
      const imageUrl = await getMediaUrl(mediaId);

      userOrders[from].status = "payment_screenshot_sent";
      userState[from].step    = "done";

      const orderId        = userOrders[from].orderId || "ORD-MANUAL";
      const productSummary = (userOrders[from].items || [])
        .map(i => `${i.name} x${i.quantity}`)
        .join(", ");
      const totalPrice = (userOrders[from].items || [])
        .reduce((s, i) => s + i.price * i.quantity, 0);

      await saveOrder({
        orderId,
        phone:      from,
        product:    productSummary,
        price:      totalPrice,
        address:    userOrders[from].address,
        status:     "Screenshot received — manual verify ⚠️",
        screenshot: imageUrl,
        raw:        JSON.stringify(userOrders[from])
      });

      await sendMessage(
        from,
        `✅ Screenshot received!\n\n🧾 Order ID: ${orderId}\n\nWe'll verify and process your order shortly 🚚\n\n💖 Thank you for shopping with Wipz!`
      );
      return res.sendStatus(200);
    }

    // ─────────────────────────────────────────────
    // 🤖 TEXT FALLBACK
    // ─────────────────────────────────────────────
    if (type === "text") {
      const text = message.text.body.toLowerCase().trim();

      // "hi" / "hello" / "start" → re-send welcome (if they've seen it before, just nudge)
      if (text === "hi" || text === "hello" || text === "start" || text === "hey") {
        // Reset for fresh session but don't spam templates again
        userState[from] = { step: "idle", seenWelcome: true };
        userOrders[from] = null;

        await sendMessage(
          from,
          "👋 Welcome back to *Wipz*! 💫\n\n😍 Browse our catalogue and pick your favourite pair 👟\n\n_(Tap the catalogue button to shop)_"
        );

      } else if (userState[from]?.step === "payment") {
        await sendMessage(from, "💳 Please tap *Review & Pay* above to complete your payment 👆");

      } else if (userState[from]?.step === "address") {
        await sendMessage(from, "📦 Please send your delivery details (Name, Address, City, Pincode) to continue.");

      } else {
        await sendMessage(from, "👉 Please select a product from catalogue to continue 🛍️");
      }

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
        to: to,
        type: "interactive",
        interactive: {
          type: "order_status",
          body: {
            text: status === "processing"
              ? "✅ Payment received! Your order is now being processed."
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
    console.error("Order status update error:", err.response?.data || err.message);
  }
}


// =========================
// 🖼️ GET MEDIA URL (for screenshot uploads)
// =========================
async function getMediaUrl(mediaId) {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/v25.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    const mediaResponse = await axios.get(response.data.url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      responseType: "arraybuffer"
    });
    return await uploadToCloudinary(mediaResponse.data);
  } catch (error) {
    console.error("Media error:", error.response?.data || error.message);
    return null;
  }
}

async function uploadToCloudinary(imageBuffer) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      { folder: "whatsapp_orders" },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    ).end(imageBuffer);
  });
}

async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Send Error:", error.response?.data || error.message);
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
    console.log("✅ Order saved to sheet");
  } catch (err) {
    console.error("Sheet error:", err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
