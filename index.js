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

      // INIT USER
      if (!userState[from]) {
        userState[from] = { step: 1 };
      }

      // 🎯 FIRST MESSAGE (from ad)
      if (userState[from].step === 1) {
        userState[from].step = 2;

        await sendButtons(from);
      }

      // 🔘 BUTTON CLICK HANDLING
      else if (type === "interactive") {
        const buttonId = message.interactive.button_reply.id;

        // 🟢 View Product
        if (buttonId === "current_product") {
          await sendMessage(
            from,
            "Please select your size, color and quantity from the product page 🛍️"
          );
        }

        // 🟢 View Catalogue
        else if (buttonId === "view_catalog") {
          await sendCatalog(from);
        }
      }

      // 🛍️ PRODUCT SELECTED
      else if (type === "order") {
        userState[from].step = 3;

        await sendMessage(
          from,
          "Awesome 😍\n\nPlease send your full delivery address with pincode 📦"
        );
      }

      // 📦 ADDRESS
      else if (type === "text" && userState[from].step === 3) {
        userState[from].step = 4;

        await sendMessage(
          from,
          "✅ Almost done!\n\n💳 UPI ID: pkt800@upi\n\nPlease complete payment and send screenshot 📸"
        );
      }

      // 📸 PAYMENT
      else if (type === "image") {
        userState[from].step = 5;

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
async function sendButtons(to) {
  await axios.post(
    "https://graph.facebook.com/v18.0/973822219157793/messages",
    {
      messaging_product: "whatsapp",
      to: to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: "😍 Here’s the product you selected!\n\nWhat would you like to do next?"
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "current_product",
                title: "View This Product"
              }
            },
            {
              type: "reply",
              reply: {
                id: "view_catalog",
                title: "View Catalogue"
              }
            }
          ]
        }
      }
    },
    {
      headers: {
        Authorization: "Bearer EAALcQJ0mJBABRNYrxjwYjamxvKIff0y5tYOg0UR8BFP4uMAvCKILLzLB80tGn8WTKcgBZBbL9BnNyZA6SE5Wts93HzSe8fl6EkFhdZBPYrXRgtaeBZAjUYPGqlWDtZCinXtClGrVTtELTcrZAv2Gn6eTFEGU17lFW6tltEwV0pfZCo45ZCMfnoYqXBnZAZBJOjHAqGGpS6YINTqvd86v3bEecp3SpWNEDvHaGMJUDpXGoQPnj3oJZCO2P3MpNPu1cVoJlhgGhMOLfKS4dJ48onH7UMo9ibn",
        "Content-Type": "application/json"
      }
    }
  );
}
async function sendCatalog(to) {
  await axios.post(
    "https://graph.facebook.com/v18.0/YOUR_PHONE_NUMBER_ID/messages",
    {
      messaging_product: "whatsapp",
      to: to,
      type: "interactive",
      interactive: {
        type: "catalog_message",
        body: {
          text: "Browse our full collection 🛍️"
        },
        action: {
          name: "catalog_message",
          parameters: {
            catalog_id: "1427937995741072"
          }
        }
      }
    },
    {
      headers: {
        Authorization: "Bearer YOUR_ACCESS_TOKEN",
        "Content-Type": "application/json"
      }
    }
  );
}
// 🚀 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running"));
