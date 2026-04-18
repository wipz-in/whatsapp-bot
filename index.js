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

// 🔐 ENV VARIABLES (set in Render)
const VERIFY_TOKEN   = "my_verify_token";
const PHONE_ID       = process.env.PHONE_NUMBER_ID;
const TOKEN          = process.env.ACCESS_TOKEN;
const UPI_VPA        = process.env.UPI_VPA  || "9657748074-3@ibl";
const UPI_NAME       = process.env.UPI_NAME || "Wipz";

// ✅ EXACT name from WhatsApp Manager → Payment configurations
const PAYMENT_CONFIG_NAME = "whatsapp_orders";

// 🧠 Memory (temporary storage)
const userState  = {};
const userOrders = {};


// =========================
// ✅ WEBHOOK VERIFY
// =========================
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
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
// 💳 SEND NATIVE WHATSAPP PAYMENT MESSAGE
//
// Uses "whatsapp_orders" VPA config from WhatsApp Manager.
// Shows a "Review & Pay" button — customer taps and their
// UPI app opens with amount pre-filled.
// =========================
async function sendUpiPaymentMessage(to, orderDetails) {
  const { price, name, orderId } = orderDetails;

  // Amount must be in PAISE (₹1 = 100 paise)
  const amountInPaise = Math.round(price * 100);

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to,
    type: "interactive",
    interactive: {
      type: "order_details",
      body: {
        text: `Here's your order summary for *${name}* 🛍️\n\nTap *Review & Pay* to complete payment via UPI ✅`
      },
      footer: {
        text: "Wipz — Loved by 1000+ customers 💖"
      },
      action: {
        name: "review_and_pay",
        parameters: {
          reference_id: orderId,
          type: "digital-goods",
          payment_type: "upi_intent",
          payment_configuration: PAYMENT_CONFIG_NAME,  // ✅ "whatsapp_orders"
          currency: "INR",
          total_amount: {
            value: amountInPaise,   // e.g. ₹309 → 30900
            offset: 100
          },
          order: {
            status: "pending",
            items: [
              {
                retailer_id: String(orderId),
                name: name,
                amount: {
                  value: amountInPaise,
                  offset: 100
                },
                quantity: 1
              }
            ],
            subtotal: {
              value: amountInPaise,
              offset: 100
            },
            tax: {
              value: 0,
              offset: 100,
              description: "GST Inclusive"
            },
            shipping: {
              value: 0,
              offset: 100,
              description: "Free Delivery"
            },
            discount: {
              value: 0,
              offset: 100,
              description: ""
            }
          }
        }
      }
    }
  };

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    console.log("✅ Payment message sent:", JSON.stringify(response.data, null, 2));

  } catch (error) {
    const errData = error.response?.data;
    console.error("❌ Payment message failed:", JSON.stringify(errData, null, 2));

    // ⚠️ FALLBACK: show UPI details as plain text
    await sendMessage(
      to,
      `💳 *Complete your payment manually:*\n\nUPI ID: *${UPI_VPA}*\nAmount: *₹${price}*\nName: ${UPI_NAME}\n\n_After payment, send screenshot + UTR 📸_`
    );
  }
}


// =========================
// 🚀 MAIN WEBHOOK
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // ================================================
    // ✅ PAYMENT STATUS CALLBACK FROM META
    // Meta sends this when customer completes UPI payment
    // ================================================
    const incomingMsg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (
      incomingMsg?.type === "interactive" &&
      incomingMsg?.interactive?.type === "payment_info"
    ) {
      const from        = incomingMsg.from;
      const paymentInfo = incomingMsg.interactive.payment_info;
      const status      = paymentInfo?.payment_status;   // "captured" | "failed"
      const referenceId = paymentInfo?.reference_id;
      const txnId       = paymentInfo?.transaction_id;
      const amount      = (paymentInfo?.total_amount?.value || 0) / 100;

      console.log(`💰 Payment [${status}] — Order: ${referenceId}, TXN: ${txnId}`);

      if (status === "captured") {
        if (userOrders[from]) {
          userOrders[from].status        = "paid";
          userOrders[from].transactionId = txnId;
        }

        await saveOrder({
          orderId:    referenceId,
          phone:      from,
          product:    userOrders[from]?.name    || "",
          price:      amount,
          address:    userOrders[from]?.address || "",
          status:     "PAID ✅",
          screenshot: `UPI TXN: ${txnId}`,
          raw:        JSON.stringify(paymentInfo)
        });

        userState[from] = { step: "done" };

        await sendMessage(
          from,
          `✅ *Payment Confirmed!*\n\n🧾 Order ID: *${referenceId}*\n💰 Amount Paid: ₹${amount}\n🔖 UTR/TXN ID: ${txnId}\n\nYour order is being processed 🚚\nYou'll receive shipping updates soon!\n\n💖 Thank you for shopping with *Wipz*!`
        );

        await sendOrderStatusUpdate(from, referenceId, "processing");

      } else if (status === "failed") {
        await sendMessage(
          from,
          `❌ Payment failed for Order *${referenceId}*.\n\nPlease try again 👇`
        );
        if (userOrders[from]) {
          await sendUpiPaymentMessage(from, {
            price:   userOrders[from].price,
            name:    userOrders[from].name,
            orderId: referenceId
          });
        }
      }

      return res.sendStatus(200);
    }

    // ================================================
    // Normal message flow
    // ================================================
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const type = message.type;

    // Log chat
    let logMessage = message.text?.body || type;
    if (type === "order") {
      const product = message.order?.product_items?.[0];
      logMessage = product?.product_retailer_id || "Order placed";
    }
    await saveChatLog({
      phone:   from,
      message: logMessage,
      step:    userState[from]?.step || "new"
    });

    console.log("Incoming:", JSON.stringify(message, null, 2));

    if (!userState[from]) {
      userState[from] = { step: "idle" };
    }

    // =========================
    // 🛍️ ORDER FROM CATALOG
    // =========================
    if (type === "order") {
      const product  = message.order?.product_items?.[0];
      const price    = product?.item_price || 0;
      const name     = product?.product_retailer_id || "Product";
      const quantity = product?.quantity || 1;
      const imageUrl = product?.image?.link || null;

      userOrders[from] = { price, name, status: "product_selected" };

      if (imageUrl) {
        await axios.post(
          `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to: from,
            type: "image",
            image: {
              link: imageUrl,
              caption: `🛍️ *${name}*\n\nQty: ${quantity}\nPrice: ₹${price}`
            }
          },
          { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
        );
      }

      userState[from].step = "address";
      await sendMessage(
        from,
        `😍 *${name}* selected!\n\nPlease send your delivery details:\n\nName:\nAddress:\nCity:\nPincode:\n📦`
      );
      return res.sendStatus(200);
    }

    // =========================
    // 📦 ADDRESS → SEND PAYMENT
    // =========================
    if (type === "text" && userState[from]?.step === "address") {
      userOrders[from].address = message.text.body;
      userOrders[from].status  = "address_received";

      const now     = new Date();
      const orderId =
        "ORD" +
        now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }).replace(/\//g, "") +
        "-" +
        now.getTime().toString().slice(-5);

      userOrders[from].orderId = orderId;
      userState[from].step     = "payment";

      await sendMessage(from, "🎉 Almost there! Here's your order summary with payment button 👇");

      // ✅ Send native WhatsApp UPI payment message
      await sendUpiPaymentMessage(from, {
        price:   userOrders[from].price,
        name:    userOrders[from].name,
        orderId: orderId
      });

      await sendMessage(
        from,
        "_Tap *Review & Pay* above to pay via Google Pay, PhonePe, Paytm or any UPI app 📱_"
      );

      return res.sendStatus(200);
    }

    // =========================
    // 📸 MANUAL SCREENSHOT FALLBACK
    // =========================
    if (type === "image" && userState[from]?.step === "payment") {
      const mediaId  = message.image.id;
      const imageUrl = await getMediaUrl(mediaId);

      userOrders[from].status = "payment_screenshot_sent";
      userState[from].step    = "done";

      const orderId = userOrders[from].orderId || "ORD-MANUAL";

      await saveOrder({
        orderId,
        phone:      from,
        product:    userOrders[from].name,
        price:      userOrders[from].price,
        address:    userOrders[from].address,
        status:     "Screenshot received — manual verify needed ⚠️",
        screenshot: imageUrl,
        raw:        JSON.stringify(userOrders[from])
      });

      await sendMessage(
        from,
        `✅ Screenshot received!\n\n🧾 Order ID: ${orderId}\n\nWe'll verify your payment and process your order shortly 🚚\n\n💖 Thank you for shopping with Wipz!`
      );

      return res.sendStatus(200);
    }

    // =========================
    // 🤖 FALLBACK / GREET
    // =========================
    if (type === "text") {
      const text = message.text.body.toLowerCase();

      if (text.includes("hi") || text.includes("hello")) {
        userState[from] = { step: "idle" };
        delete userOrders[from];

        await sendMessage(
          from,
          "👋 Hey! Welcome to *Wipz* 💫\n\nWe bring you stylish & super-comfy Women's Footwear,\nperfect for daily wear + outings ✨\n\n🔥 Loved by 1000+ happy customers.\n\n_Proudly Made in Maharashtra_"
        );
        await sendMessage(
          from,
          "😍 Let's find your perfect pair!\n\n🛍️ *Please select a product from the catalogue above.*\n\n_(Tap on catalogue button at top)_"
        );

      } else if (userState[from]?.step === "payment") {
        await sendMessage(from, "💳 Please tap *Review & Pay* above to complete your payment 👆");

      } else {
        await sendMessage(from, "👉 Please select a product from catalogue to continue 🛍️");
      }

      return res.sendStatus(200);
    }

    res.sendStatus(200);

  } catch (err) {
    console.error(err.response?.data || err.message);
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
            parameters: {
              reference_id: referenceId,
              order_status: status
            }
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
// 🖼️ GET MEDIA URL
// =========================
async function getMediaUrl(mediaId) {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/v25.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    const mediaUrl      = response.data.url;
    const mediaResponse = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      responseType: "arraybuffer"
    });
    const uploadedUrl = await uploadToCloudinary(mediaResponse.data);
    console.log("Uploaded Image URL:", uploadedUrl);
    return uploadedUrl;
  } catch (error) {
    console.error("Media error:", error.response?.data || error.message);
    return null;
  }
}


// =========================
// ☁️ CLOUDINARY UPLOAD
// =========================
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


// =========================
// 📤 SEND TEXT MESSAGE
// =========================
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text }
      },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Send Error:", error.response?.data || error.message);
  }
}


// =========================
// 💾 SAVE ORDER TO SHEET
// =========================
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


// 🚀 START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
