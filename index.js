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
const VERIFY_TOKEN = "my_verify_token";
const PHONE_ID = process.env.PHONE_NUMBER_ID;
const TOKEN = process.env.ACCESS_TOKEN;

// ✅ Your UPI VPA (Virtual Payment Address)
// Set this in Render env as UPI_VPA, e.g. "9657748074-3@ibl"
const UPI_VPA = process.env.UPI_VPA || "9657748074-3@ibl";

// ✅ Your business/store name shown in UPI apps
const UPI_NAME = process.env.UPI_NAME || "Wipz";

// 🧠 Memory (temporary storage)
const userState = {};
const userOrders = {};


// =========================
// ✅ WEBHOOK VERIFY
// =========================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
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
        values: [
          [
            new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
            data.phone,
            data.message,
            data.step
          ]
        ]
      }
    });
  } catch (err) {
    console.error("Chat log error:", err.message);
  }
}

// =========================
// 💳 SEND UPI INTENT PAYMENT MESSAGE
// Using Meta's native order_details interactive message
// No PG/Razorpay config needed — opens any UPI app directly
// =========================
async function sendUpiPaymentMessage(to, orderDetails) {
  const { price, name, orderId } = orderDetails;

  // Amount in paise (offset: 100 means value is in paise, so ₹1 = 100)
  const amountInPaise = Math.round(price * 100);

  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "interactive",
        interactive: {
          type: "order_details",
          body: {
            text: `💳 Complete your payment for *${name}*\n\nYour UPI app will open automatically to pay ✅`
          },
          footer: {
            text: "Wipz — Trusted by 1000+ customers 💖"
          },
          action: {
            name: "review_and_pay",
            parameters: {
              reference_id: orderId,         // your internal order reference
              type: "digital-goods",          // use "physical-goods" if you prefer
              payment_type: "upi_intent",     // ✅ UPI Intent — no PG setup needed
              payment_settings: [
                {
                  type: "upi_intent",
                  upi_intent: {
                    upi_payee_vpa: UPI_VPA,         // your UPI ID, e.g. 9657748074-3@ibl
                    upi_payee_name: UPI_NAME        // displayed in UPI app
                  }
                }
              ],
              currency: "INR",
              total_amount: {
                value: amountInPaise,   // e.g. ₹499 → 49900
                offset: 100             // tells Meta: divide by 100 to get ₹
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
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("✅ UPI Intent payment message sent to", to);
  } catch (error) {
    console.error("❌ Payment message error:", error.response?.data || error.message);

    // ====================================================
    // ⚠️ FALLBACK: If order_details is not enabled on your
    // WABA yet, fall back to the plain UPI link as text.
    // Remove this fallback once Meta enables it for you.
    // ====================================================
    console.log("⚠️ Falling back to plain UPI link...");
    const upiLink = `upi://pay?pa=${UPI_VPA}&pn=${encodeURIComponent(UPI_NAME)}&am=${price}&cu=INR&tn=Order_${orderId}`;
    await sendMessage(to, `💳 Pay using UPI:\n\n${upiLink}\n\n_After payment, send screenshot + UTR 📸_`);
  }
}

// =========================
// 🚀 MAIN WEBHOOK
// =========================

app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // ================================================
    // ✅ HANDLE PAYMENT STATUS WEBHOOK FROM META
    // Meta sends this when customer completes UPI payment
    // ================================================
    const paymentUpdate = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (
      paymentUpdate?.type === "interactive" &&
      paymentUpdate?.interactive?.type === "payment_info"
    ) {
      const from = paymentUpdate.from;
      const paymentInfo = paymentUpdate.interactive.payment_info;
      const paymentStatus = paymentInfo?.payment_status;   // "captured" or "failed"
      const referenceId = paymentInfo?.reference_id;
      const transactionId = paymentInfo?.transaction_id;
      const amount = paymentInfo?.total_amount?.value / 100; // convert paise → ₹

      console.log(`💰 Payment ${paymentStatus} for order ${referenceId}, txn: ${transactionId}`);

      if (paymentStatus === "captured") {
        // ✅ Payment confirmed by Meta
        if (userOrders[from]) {
          userOrders[from].status = "paid";
          userOrders[from].transactionId = transactionId;
        }

        // Update order in Google Sheet
        await saveOrder({
          orderId: referenceId,
          phone: from,
          product: userOrders[from]?.name || "",
          price: amount,
          address: userOrders[from]?.address || "",
          status: "PAID ✅",
          screenshot: `UPI TXN: ${transactionId}`,
          raw: JSON.stringify(paymentInfo)
        });

        userState[from] = { step: "done" };

        await sendMessage(
          from,
          `✅ *Payment Confirmed!*\n\n🧾 Order ID: *${referenceId}*\n💰 Amount: ₹${amount}\n🔖 UTR/TXN: ${transactionId}\n\nYour order is being processed 🚚\nYou'll receive shipping updates soon\n\n💖 Thank you for shopping with *Wipz*!`
        );

        // Send order status update (updates the order card in chat)
        await sendOrderStatusUpdate(from, referenceId, "processing");

      } else if (paymentStatus === "failed") {
        // ❌ Payment failed
        await sendMessage(
          from,
          `❌ Payment failed for Order ${referenceId}.\n\nPlease try again 👇`
        );
        // Re-send the payment message
        if (userOrders[from]) {
          await sendUpiPaymentMessage(from, {
            price: userOrders[from].price,
            name: userOrders[from].name,
            orderId: referenceId
          });
        }
      }

      return res.sendStatus(200);
    }

    // ================================================
    // Normal message handling below
    // ================================================
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const type = message.type;

    // =========================
    // 📝 SAVE CHAT LOG
    // =========================
    let logMessage = message.text?.body || type;
    if (type === "order") {
      const product = message.order?.product_items?.[0];
      logMessage = product?.product_retailer_id || "Order placed";
    }
    await saveChatLog({
      phone: from,
      message: logMessage,
      step: userState[from]?.step || "new"
    });

    console.log("Incoming:", JSON.stringify(message, null, 2));

    // INIT USER
    if (!userState[from]) {
      userState[from] = { step: "idle" };
    }

    // =========================
    // 🛍️ ORDER FROM CATALOG
    // =========================
    if (type === "order") {
      const product = message.order?.product_items?.[0];

      const price = product?.item_price || 0;
      const name = product?.product_retailer_id || "Product";
      const quantity = product?.quantity || 1;
      const imageUrl = product?.image?.link || null;

      userOrders[from] = {
        price,
        name,
        status: "product_selected"
      };

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
          {
            headers: {
              Authorization: `Bearer ${TOKEN}`,
              "Content-Type": "application/json"
            }
          }
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
    // 📦 ADDRESS → TRIGGER PAYMENT
    // =========================
    if (type === "text" && userState[from]?.step === "address") {
      userOrders[from].address = message.text.body;
      userOrders[from].status = "address_received";

      // Generate Order ID now (used as reference_id in payment)
      const now = new Date();
      const orderId =
        "ORD" +
        now.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }).replace(/\//g, "") +
        "-" +
        now.getTime().toString().slice(-5);

      userOrders[from].orderId = orderId;

      userState[from].step = "payment";

      await sendMessage(from, "🎉 Great! Here's your order summary with payment button 👇");

      // ✅ Send the native WhatsApp UPI Intent payment message
      await sendUpiPaymentMessage(from, {
        price: userOrders[from].price,
        name: userOrders[from].name,
        orderId: orderId
      });

      await sendMessage(
        from,
        "_Tap the *Review & Pay* button above to complete payment via any UPI app_ 📱"
      );

      return res.sendStatus(200);
    }

    // =========================
    // 📸 MANUAL SCREENSHOT FALLBACK
    // (Only if customer sends screenshot manually,
    //  e.g. when UPI Intent webhook doesn't fire)
    // =========================
    if (type === "image" && userState[from]?.step === "payment") {
      const mediaId = message.image.id;
      const imageUrl = await getMediaUrl(mediaId);

      userOrders[from].status = "payment_screenshot_sent";
      userState[from].step = "done";

      const orderId = userOrders[from].orderId || "ORD-MANUAL";

      await saveOrder({
        orderId: orderId,
        phone: from,
        product: userOrders[from].name,
        price: userOrders[from].price,
        address: userOrders[from].address,
        status: "Screenshot received (manual verify needed)",
        screenshot: imageUrl,
        raw: JSON.stringify(userOrders[from])
      });

      await sendMessage(
        from,
        `✅ Screenshot received!\n\n🧾 Order ID: ${orderId}\n\nWe'll verify your payment shortly and process your order 🚚\n\n💖 Thank you for shopping with Wipz!`
      );

      return res.sendStatus(200);
    }

    // =========================
    // 🤖 SMART FALLBACK
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
        // Remind to pay
        await sendMessage(from, "💳 Please tap the *Review & Pay* button above to complete your payment 👆");
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
// 📦 SEND ORDER STATUS UPDATE
// Updates the order card in WhatsApp chat after payment
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
              ? "✅ Your payment was received! Order is now being processed."
              : `📦 Your order status: ${status}`
          },
          action: {
            name: "shipment_update",
            parameters: {
              reference_id: referenceId,
              order_status: status   // "processing" | "shipped" | "completed"
            }
          }
        }
      },
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (err) {
    // Non-critical — log and continue
    console.error("Order status update error:", err.response?.data || err.message);
  }
}

// =========================
// 🖼️ GET MEDIA URL (unchanged)
// =========================
async function getMediaUrl(mediaId) {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/v25.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    const mediaUrl = response.data.url;
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
// ☁️ CLOUDINARY UPLOAD (unchanged)
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
// 📤 SEND MESSAGE (unchanged)
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
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error("Send Error:", error.response?.data || error.message);
  }
}

// =========================
// 💾 SAVE ORDER TO SHEET (unchanged)
// =========================
async function saveOrder(data) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            data.orderId || "",
            new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
            data.phone || "",
            data.product || "",
            data.price || "",
            data.address || "",
            data.status || "",
            data.screenshot || "",
            data.raw || ""
          ]
        ]
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
