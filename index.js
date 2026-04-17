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
// 🚀 MAIN WEBHOOK
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const type = message.type;

    console.log("Incoming:", JSON.stringify(message, null, 2));

    // INIT USER
    if (!userState[from]) {
      userState[from] = { step: "idle" };
    }

    // =========================
    // 🛍️ ORDER (ALWAYS OVERRIDE)
    // =========================
    if (type === "order") {
      const product = message.order?.product_items?.[0];

      const price = product?.item_price || 0;
      const name = product?.product_retailer_id || "Product";

      userOrders[from] = {
        price,
        name,
        status: "product_selected"
      };

      userState[from].step = "address";

      await sendMessage(
        from,
        `😍 *${name}* selected!\n\nPlease send your delivery details:\n\nName:\nAddress:\nCity:\nPincode:\n📦`
      );

      return res.sendStatus(200);
    }

    // =========================
    // 📦 ADDRESS
    // =========================
   if (type === "text" && userState[from].step === "address") {
  userOrders[from].address = message.text.body;
  userOrders[from].status = "address_received";

  const amount = userOrders[from].price || 0;

  // ✅ Correct UPI link (NO https)
  const upiLink = `https://upi://pay?pa=9657748074-3@ibl&pn=Wipz&am=${amount}&cu=INR`;

  userState[from].step = "payment";

  // ✅ Message 1
  await sendMessage(
    from,
    "💳 Please complete your payment using the link below 👇"
  );

  // ✅ Message 2 (ONLY LINK → clickable)
  await sendMessage(
    from,
    upiLink
  );

  // ✅ Message 3
  await sendMessage(
    from,
    "After payment, send screenshot + UTR 📸"
  );

  return res.sendStatus(200);
}

    // =========================
    // 📸 PAYMENT SCREENSHOT
    // =========================
    if (type === "image" && userState[from].step === "payment") {
  const mediaId = message.image.id;
  const imageUrl = await getMediaUrl(mediaId); // ✅ ADD THIS

  userOrders[from].status = "payment_sent";
  console.log("Image ID:", mediaId);

  userState[from].step = "done";

  const orderId = "ORD" + Date.now();
  userOrders[from].orderId = orderId;

  // ✅ SAVE TO GOOGLE SHEET
  await saveOrder({
    orderId: orderId,
    phone: from,
    product: userOrders[from].name,
    price: userOrders[from].price,
    address: userOrders[from].address,
    status: "Paid (pending verification)",
    screenshot: imageUrl,
    raw: JSON.stringify(userOrders[from])
  });

  await sendMessage(
    from,
    `✅ Thank you for the payment!\n\n🧾 Order ID: ${orderId}\n\nWe will confirm order shortly 🚚`
  );

  return res.sendStatus(200);
}

    // =========================
    // 🤖 SMART FALLBACK
    // =========================
    if (type === "text") {
      const text = message.text.body.toLowerCase();

      // restart
      if (text.includes("hi") || text.includes("hello")) {
        userState[from].step = "idle";

        await sendMessage(
          from,
          "👋 Welcome!\n\n🛍️ Please select a product from the catalogue above."
        );
      }

      // remind payment
      else if (userState[from].step === "payment") {
        await sendMessage(
          from,
          "💳 Please complete payment and send screenshot + UTR"
        );
      }

      // no product selected
      else {
        await sendMessage(
          from,
          "👉 Please select a product from catalogue to continue 🛍️"
        );
      }

      return res.sendStatus(200);
    }

    res.sendStatus(200);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.sendStatus(500);
  }
});

async function getMediaUrl(mediaId) {
  try {
    // Step 1: Get media info
    const response = await axios.get(
      `https://graph.facebook.com/v25.0/${mediaId}`,
      {
        headers: {
          Authorization: `Bearer EAALcQJ0mJBABRIZBbSZC8xRWwfR2PJKyFcRGW6Me5rVzNkqFQcYZCcgdrTJQuwebIoMZCDaskgAY5YoJG064j3Be7GVgVFj8OBLXA6qT7x29WJQ4lPJzDoTGjnFA9qaa2BTqf32qlx0LtWOmTJ8lGu50628Ggkvv73vMEZAGmIecSu3OwpZBgEzEdfxoptp1LObXzlF9a1fxwiMLJe26ZCOcDv3qaVe1texBCVscZC5osUFfeUGgfwQhNHRSSvEsZA6eMJuvTKJRgOH2aytSq2o2ZCWWeZA`
        }
      }
    );

    const mediaUrl = response.data.url;

    // Step 2: Download image
    const mediaResponse = await axios.get(mediaUrl, {
      headers: {
        Authorization: `Bearer EAALcQJ0mJBABRIZBbSZC8xRWwfR2PJKyFcRGW6Me5rVzNkqFQcYZCcgdrTJQuwebIoMZCDaskgAY5YoJG064j3Be7GVgVFj8OBLXA6qT7x29WJQ4lPJzDoTGjnFA9qaa2BTqf32qlx0LtWOmTJ8lGu50628Ggkvv73vMEZAGmIecSu3OwpZBgEzEdfxoptp1LObXzlF9a1fxwiMLJe26ZCOcDv3qaVe1texBCVscZC5osUFfeUGgfwQhNHRSSvEsZA6eMJuvTKJRgOH2aytSq2o2ZCWWeZA`
      },
      responseType: "arraybuffer"
    });

    // Step 3: Upload to Cloudinary
    const uploadedUrl = await uploadToCloudinary(mediaResponse.data);

    console.log("Uploaded Image URL:", uploadedUrl);

    return uploadedUrl; // ✅ FINAL RETURN

  } catch (error) {
    console.error("Media error:", error.response?.data || error.message);
    return null;
  }
}
// Save screenshot cloud
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
// 📤 SEND MESSAGE FUNCTION
// =========================
async function sendMessage(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/973822219157793/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer EAALcQJ0mJBABRIZBbSZC8xRWwfR2PJKyFcRGW6Me5rVzNkqFQcYZCcgdrTJQuwebIoMZCDaskgAY5YoJG064j3Be7GVgVFj8OBLXA6qT7x29WJQ4lPJzDoTGjnFA9qaa2BTqf32qlx0LtWOmTJ8lGu50628Ggkvv73vMEZAGmIecSu3OwpZBgEzEdfxoptp1LObXzlF9a1fxwiMLJe26ZCOcDv3qaVe1texBCVscZC5osUFfeUGgfwQhNHRSSvEsZA6eMJuvTKJRgOH2aytSq2o2ZCWWeZA`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error("Send Error:", error.response?.data || error.message);
  }
}


// =========================

async function saveOrder(data) {
  try {
    data.orderId;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            data.orderId,
            new Date().toLocaleString(),
            data.phone,
            data.product,
            data.price,
            data.address,
            data.status,
            data.screenshot,
            data.raw
          ]
        ]
      }
    });

    console.log("✅ Order saved to sheet");
  } catch (err) {
    console.error("❌ Sheet error:", err.message);
  }
}
// 🚀 START SERVER (ONLY HERE)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
