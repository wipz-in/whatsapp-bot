const express = require("express");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = "my_verify_token";

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

const axios = require("axios");

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message) {
      const from = message.from;
      const text = message.text?.body;

      console.log("User:", from, "Message:", text);

      await axios.post(
        `https://graph.facebook.com/v18.0/973822219157793/messages`,
        {
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: { body: "Thanks! Your message is received ✅" }
        },
        {
          headers: {
            Authorization: `Bearer EAALcQJ0mJBABRHcFpj5f8zgVFmoAuaWyCRUmbURlDdVZAZA1RZC9XokE6KtXI25QmQZCP2eHGyVytfA7LN19UgzVfu1tZADqTUN9mUZBSggZATpP3Dlbl1dMWtAmtQCBIYO8AX5tSAGARPCn8ZC3AKhIJfUMRRM7d7g0Yz0U78YxgrJoZB8npKHqZBZCf7ZBv5U1RjQLobcjHqPUrAq6ggODbmGIOHhrayTTuEkSnoGPoSaxdm5jInPy8ZBymBv9qYqM5LZA7baGNepXN2hh9ypjqTviC69b167gZDZD`,
            "Content-Type": "application/json"
          }
        }
      );
    }

    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});

app.listen(3000, () => console.log("Server running"));
