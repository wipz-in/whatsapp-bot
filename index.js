const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

// 🔐 VERIFY TOKEN (keep same as Meta)
const VERIFY_TOKEN = "my_verify_token";

// 🧠 Simple memory (stores user steps)
const userState = {};

// ✅ Webhook verification (DO NOT CHANGE)
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

// 🤖 MAIN BOT LOGIC
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    if (message) {
      const from = message.from;
      const type = message.type;

      console.log("Incoming:", JSON.stringify(message, null, 2));

      // 🧠 Initialize user state
      if (!userState[from]) {
        userState[from] = { step: 1 };
      }

      // 🛍️ PRODUCT SELECTED (from catalogue)
      if (type === "order") {
        userState[from].step = 2;

        await sendMessage(
          from,
          "Awesome 😍\n\nPlease send your full delivery address with pincode 📦"
        );
      }

      // 📝 TEXT MESSAGE
      else if (type === "text") {
        const text = message.text.body;

        // Step 1 → Welcome
        if (userState[from].step === 1) {
          userState[from].step = 2;

          await sendMessage(
            from,
            "Hi 👋 Welcome!\n\n🛍️ Please select a product from catalogue.\n\nOnce done, send your delivery address 📦"
          );
        }

        // Step 2 → Address received
        else if (userState[from].step === 2) {
          userState[from].step = 3;

          await sendMessage(
            from,
            "✅ Almost done!\n\n💳 UPI ID: pktambe@upi\n\nPlease complete payment and send screenshot (Including transaction ID) 📸"
          );
        }
      }

      // 📸 PAYMENT SCREENSHOT
      else if (type === "image") {
        userState[from].step = 4;

        await sendMessage(
          from,
          "🎉 Payment received!\n\nYour order is confirmed ✅\nWe will ship soon 🚚"
        );
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.sendStatus(500);
  }
});

// 📤 Send message function
async function sendMessage(to, text) {
  await axios.post(
    "https://graph.facebook.com/v18.0/973822219157793/messages",
    {
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: "Bearer EAALcQJ0mJBABRNYrxjwYjamxvKIff0y5tYOg0UR8BFP4uMAvCKILLzLB80tGn8WTKcgBZBbL9BnNyZA6SE5Wts93HzSe8fl6EkFhdZBPYrXRgtaeBZAjUYPGqlWDtZCinXtClGrVTtELTcrZAv2Gn6eTFEGU17lFW6tltEwV0pfZCo45ZCMfnoYqXBnZAZBJOjHAqGGpS6YINTqvd86v3bEecp3SpWNEDvHaGMJUDpXGoQPnj3oJZCO2P3MpNPu1cVoJlhgGhMOLfKS4dJ48onH7UMo9ibn",
        "Content-Type": "application/json"
      }
    }
  );
}

// 🚀 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running"));
