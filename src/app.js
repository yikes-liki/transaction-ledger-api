const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const accountRoutes = require("./routes/accounts");
const transactionRoutes = require("./routes/transactions");
const transferRoutes = require("./routes/transfers");
const { notFoundHandler, errorHandler } = require("./middleware/errors");

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "transaction-ledger-api" });
});

app.use("/api/accounts", accountRoutes);
app.use("/api/accounts", transactionRoutes);
app.use("/api/transfers", transferRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
