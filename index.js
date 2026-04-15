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
            Authorization: `Bearer EAALcQJ0mJBABRNYrxjwYjamxvKIff0y5tYOg0UR8BFP4uMAvCKILLzLB80tGn8WTKcgBZBbL9BnNyZA6SE5Wts93HzSe8fl6EkFhdZBPYrXRgtaeBZAjUYPGqlWDtZCinXtClGrVTtELTcrZAv2Gn6eTFEGU17lFW6tltEwV0pfZCo45ZCMfnoYqXBnZAZBJOjHAqGGpS6YINTqvd86v3bEecp3SpWNEDvHaGMJUDpXGoQPnj3oJZCO2P3MpNPu1cVoJlhgGhMOLfKS4dJ48onH7UMo9ibn`,
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
