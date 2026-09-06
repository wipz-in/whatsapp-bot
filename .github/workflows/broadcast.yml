name: Send Festive Sale Broadcast

on:
  workflow_dispatch: {}

jobs:
  broadcast:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repo
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm install axios

      - name: Run broadcast script
        env:
          PHONE_NUMBER_ID: ${{ secrets.PHONE_NUMBER_ID }}
          ACCESS_TOKEN: ${{ secrets.ACCESS_TOKEN }}
        run: node broadcast.js

      - name: Upload logs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: broadcast-logs
          path: |
            broadcast_success.log
            broadcast_failed.log
          if-no-files-found: ignore
