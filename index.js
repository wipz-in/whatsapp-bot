const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = "my_verify_token";

// memory
const userState = {};
const userOrders = {};

// VERIFY
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

// MAIN
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const from = message.from;
    const type = message.type;

    console.log("Incoming:", JSON.stringify(message, null, 2));

    // INIT
    if (!userState[from]) {
      userState[from] = { step: 1 };
    }

    // 🛍️ ORDER FROM CATALOG
    if (type === "order") {
      const product = message.order?.product_items?.[0];

      const price = product?.item_price || 0;
      const name = product?.product_retailer_id;

      userOrders[from] = { price, name };

      // 👉 Trigger Flow later (for now simple message)
      await sendMessage(
        from,
        "Great choice 😍\n\nNow please fill your delivery details 👇"
      );

      // (Next step: Flow trigger)

      userState[from].step = 2;

      return res.sendStatus(200);
    }

    // 📦 ADDRESS (temporary text until Flow added)
    if (type === "text" && userState[from].step === 2) {
      const address = message.text.body;

      userOrders[from].address = address;

      const amount = userOrders[from].price;

      const upiLink = `upi://pay?pa=pktambe@upi&pn=Wipz&am=${amount}`;

      await sendMessage(
        from,
        `💳 Pay here:\n${upiLink}\n\nAfter payment, send screenshot + UTR`
      );

      userState[from].step = 3;

      return res.sendStatus(200);
    }

    // 📸 PAYMENT
    if (type === "image") {
      await sendMessage(
        from,
        "✅ Payment received!\n\nWe will verify and confirm your order 🚚"
      );

      return res.sendStatus(200);
    }

    // 🎯 FIRST MESSAGE
    if (userState[from].step === 1) {
      userState[from].step = 99;

      await sendMessage(
        from,
        "😍 Welcome!\n\n🛍️ Tap 'View Catalogue' at top 👆\nSelect your product, then continue here"
      );

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// SEND TEXT
async function sendMessage(to, text) {
  await axios.post(
    "https://graph.facebook.com/v25.0/973822219157793/messages",
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: "Bearer EAALcQJ0mJBABRFZA3HFXWNQLnsMakmbZAbghFNLfvZCdn1wBIw0eDvZCTEM5z6i2heFr0INFNfBqIDuFdb8Pi8R5OzEFPea3RPf1IQnWHlJkg5FFLpyIDa7Kv5ez39SrgN5AGKZASspjK5N0FFCNzl05MZBQA3FdxqTXYyXLv6zYI0HSyE5HGkmd9jW7TFZBpBCZB33dndDeKaHFpHa7WfhhfXfvqUdTKat1gZBJpnzXGeenEyATAtgZCqh9njxxIBMcgSbnp5BfBoqW4m2E5jJZAUPsVHO",
        "Content-Type": "application/json"
      }
    }
  );
}

app.listen(3000, () => console.log("Server running"));
