const { z } = require("zod");

const uuidSchema = z.string().uuid("Must be a valid UUID.");
const accountSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120, "Name must be at most 120 characters.")
}).strict();

const transactionSchema = z.object({
  type: z.enum(["credit", "debit"]),
  amount: z.number().finite().positive().max(999999999999.99),
  description: z.string().trim().max(500).optional().default(""),
  reference_id: z.string().trim().min(1, "reference_id is required.").max(120)
}).strict();

const transferSchema = z.object({
  from_account_id: uuidSchema,
  to_account_id: uuidSchema,
  amount: z.number().finite().positive().max(999999999999.99),
  reference_id: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().default("Money transfer")
}).strict().refine((data) => data.from_account_id !== data.to_account_id, {
  message: "Source and destination accounts must be different.",
  path: ["to_account_id"]
});

function parsePositiveInteger(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(String(value))) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) return null;
  return number;
}

module.exports = {
  uuidSchema,
  accountSchema,
  transactionSchema,
  transferSchema,
  parsePositiveInteger
};
