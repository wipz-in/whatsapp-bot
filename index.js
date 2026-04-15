const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = "my_verify_token";

// simple memory
const userState = {};

// ✅ WEBHOOK VERIFY (KEEP)
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

// ✅ MAIN BOT
app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    const type = message.type;

    console.log("Incoming:", JSON.stringify(message, null, 2));

    // 🧠 INIT USER
    if (!userState[from]) {
      userState[from] = { step: 1 };
    }

    // 🔘 BUTTON / LIST CLICK (FIRST PRIORITY)
    if (type === "interactive") {
      const id =
        message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.id;

      console.log("Clicked:", id);

      if (id === "current_product") {
        await sendProduct(from);
      }

      if (id === "view_catalog") {
        await sendCatalog(from);
      }

      return res.sendStatus(200);
    }

    // 🎯 FIRST MESSAGE (ALWAYS TRIGGER)
    if (userState[from].step === 1) {
      userState[from].step = 2;

      await sendList(from);

      return res.sendStatus(200);
    }

    // 🛍️ PRODUCT SELECTED
    if (type === "order") {
      userState[from].step = 3;

      await sendMessage(
        from,
        "Awesome 😍\n\nPlease send your delivery address with pincode 📦"
      );

      return res.sendStatus(200);
    }

    // 📦 ADDRESS
    if (type === "text" && userState[from].step === 3) {
      userState[from].step = 4;

      await sendMessage(
        from,
        "✅ Almost done!\n\n💳 UPI ID: pktambe@upi\n\nSend payment screenshot 📸"
      );

      return res.sendStatus(200);
    }

    // 📸 PAYMENT
    if (type === "image") {
      userState[from].step = 5;

      await sendMessage(
        from,
        "🎉 Payment received!\n\nOrder confirmed ✅"
      );

      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("ERROR:", error.response?.data || error.message);
    res.sendStatus(500);
  }
});

// 📤 TEXT MESSAGE
async function sendMessage(to, text) {
  await axios.post(
    "https://graph.facebook.com/v18.0/973822219157793/messages",
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: "Bearer EAALcQJ0mJBABRA4mVrD0QMcEyFk0QfQR38Pr45hZAOfAaB9CyIEwDZAFpRT2ZAZCprU35JpLotAABbGQBgF0Jc2RqoMdwbmNzYk0XcQynQBGw3eJhOeTvZBcAGpB0EskJ6SjxJh6tWHI4tIFx30BxEoN4N72KYBcZCKUd8DfO3ShHGYjITj6DLgqeelDPoXO1jHZCYShptnj6kxzWZCB4Ahj0Icl4mFGWtZB6R2aekaue11cM85ZAaVFeCSl99Ub43HBROfPnIIihWEuZBCJcIlM0iyGWeW",
        "Content-Type": "application/json"
      }
    }
  );
}

// 📋 LIST MENU (YOUR UI)
async function sendList(to) {
  await axios.post(
    "https://graph.facebook.com/v18.0/973822219157793/messages",
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: {
          text: "😍 Here’s the product you selected!\n\nChoose an option:"
        },
        action: {
          button: "Select Option",
          sections: [
            {
              title: "Product Options",
              rows: [
                {
                  id: "current_product",
                  title: "View This Product"
                },
                {
                  id: "view_catalog",
                  title: "View Catalogue"
                }
              ]
            }
          ]
        }
      }
    },
    {
      headers: {
        Authorization: "Bearer EAALcQJ0mJBABRA4mVrD0QMcEyFk0QfQR38Pr45hZAOfAaB9CyIEwDZAFpRT2ZAZCprU35JpLotAABbGQBgF0Jc2RqoMdwbmNzYk0XcQynQBGw3eJhOeTvZBcAGpB0EskJ6SjxJh6tWHI4tIFx30BxEoN4N72KYBcZCKUd8DfO3ShHGYjITj6DLgqeelDPoXO1jHZCYShptnj6kxzWZCB4Ahj0Icl4mFGWtZB6R2aekaue11cM85ZAaVFeCSl99Ub43HBROfPnIIihWEuZBCJcIlM0iyGWeW",
        "Content-Type": "application/json"
      }
    }
  );
}

// 🛍️ PRODUCT LIST (WORKING METHOD)
async function sendCatalog(to) {
  await axios.post(
    "https://graph.facebook.com/v18.0/973822219157793/messages",
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "product_list",
        body: {
          text: "🛍️ Our Products"
        },
        action: {
          catalog_id: "1427937995741072",
          sections: [
            {
              title: "Best Sellers",
              product_items: [
                { product_retailer_id: "zv4ny1m0a4" },
                { product_retailer_id: "zv4ny1m0a4" }
              ]
            }
          ]
        }
      }
    },
    {
      headers: {
        Authorization: "Bearer EAALcQJ0mJBABRA4mVrD0QMcEyFk0QfQR38Pr45hZAOfAaB9CyIEwDZAFpRT2ZAZCprU35JpLotAABbGQBgF0Jc2RqoMdwbmNzYk0XcQynQBGw3eJhOeTvZBcAGpB0EskJ6SjxJh6tWHI4tIFx30BxEoN4N72KYBcZCKUd8DfO3ShHGYjITj6DLgqeelDPoXO1jHZCYShptnj6kxzWZCB4Ahj0Icl4mFGWtZB6R2aekaue11cM85ZAaVFeCSl99Ub43HBROfPnIIihWEuZBCJcIlM0iyGWeW",
        "Content-Type": "application/json"
      }
    }
  );
}

// 🚀 START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running"));
