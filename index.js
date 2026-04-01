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

app.post("/webhook", (req, res) => {
  console.log("Incoming:", JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.listen(3000, () => console.log("Server running"));
