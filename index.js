const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
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

      const upiLink = `https://upi://pay?pa=pktambe@upi&pn=Wipz&am=${amount}`;

      userState[from].step = "payment";

      await sendMessage(
        from,
        `💳 Pay here:\n${upiLink}\n\nAfter payment:\nSend screenshot + UTR`
      );

      return res.sendStatus(200);
    }

    // =========================
    // 📸 PAYMENT SCREENSHOT
    // =========================
    if (type === "image" && userState[from].step === "payment") {
  userOrders[from].status = "payment_sent";

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
          Authorization: `Bearer EAALcQJ0mJBABRCwZASFE5J6ONuOGwOMxWI4LMRyzzQPjlsA4BFB6hIdVt4qt8chHNnPY3rkdFZBDFEDH7AVlYsKw5e0WZCgVHnUAzkXBcfTNHLwnLzhHV3DiTd0MZBfGL5fO0bEoY0tPQ1LAnA2bZCYlNdMwBXfutRCa4ACb5t1qelJ8sLx0slzTWoDFdjN1t0VSob92bqdEbMJjtoLStPZAdmjTfKIa8YIvAGS8CCAZAUrJcZBZCBjZCknX4ZBMYX28sdygx6k4DdqZAaoxzGAJx2UgXjLk`,
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
