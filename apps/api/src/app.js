import express from "express";
import helmet from "helmet";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const nonempty = z.string().trim().min(1);
const email = z
  .string()
  .trim()
  .pipe(z.email())
  .transform((value) => value.toLowerCase());
const details = z.object({ slot_id: nonempty, name: nonempty, email });
const slot = z
  .object({
    id: nonempty,
    provider: nonempty,
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  })
  .refine((value) => Date.parse(value.end) > Date.parse(value.start));
const reset = z
  .object({ slots: z.array(slot) })
  .refine(
    (value) =>
      new Set(value.slots.map((item) => item.id)).size === value.slots.length,
  );
const page = z.object({
  email,
  limit: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50))
    .default(10),
  cursor: z.string().min(1).optional(),
});
const cursorSchema = z
  .object({ email, id: z.uuid(), created_at: z.iso.datetime() })
  .strict();
const fail = (res, status, error) => res.status(status).json({ error });

function sameKey(actual, expected) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ store, apiKey, production = false }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  const auth = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!sameKey(req.get("x-api-key"), apiKey))
      return fail(res, 401, "A valid API key is required.");
    next();
  };
  app.use("/api", auth);
  app.use(["/reset", "/slots", "/bookings"], auth);
  app.use(express.json({ limit: "256kb" }));

  // Root paths match the assessment spec; /api aliases serve the web client.
  for (const prefix of ["", "/api"]) {
    app.post(`${prefix}/reset`, async (req, res) => {
      const input = reset.safeParse(req.body);
      if (!input.success)
        return fail(
          res,
          400,
          "Invalid slots. Supply unique IDs, providers and valid start/end timestamps.",
        );
      await store.reset(input.data.slots);
      res.json({ ok: true });
    });
    app.get(`${prefix}/slots`, async (req, res) => {
      if (
        req.query.provider !== undefined &&
        typeof req.query.provider !== "string"
      )
        return fail(res, 400, "Invalid provider.");
      res.json({ slots: await store.slots(req.query.provider) });
    });
    app.post(`${prefix}/bookings`, async (req, res) => {
      if (!req.is("application/json"))
        return fail(res, 415, "Send application/json.");
      // Count failed attempts too, before validation and idempotency replay.
      if (typeof req.body?.email === "string" && req.body.email.trim()) {
        const retry = await store.attempt(req.body.email.trim().toLowerCase());
        if (retry !== null) {
          res.set("Retry-After", String(retry));
          return fail(res, 429, "Too many booking attempts for this email.");
        }
      }
      const idempotencyKey = req.get("idempotency-key");
      if (
        idempotencyKey !== undefined &&
        (!idempotencyKey.trim() || idempotencyKey.length > 255)
      )
        return fail(
          res,
          400,
          "Idempotency-Key must contain 1 to 255 characters.",
        );
      const input = details.safeParse(req.body);
      const result = await store.create({
        body: req.body,
        data: input.success ? input.data : null,
        idempotencyKey,
      });
      res.status(result.status).json(result.body);
    });
    app.get(`${prefix}/bookings`, async (req, res) => {
      const input = page.safeParse(req.query);
      if (!input.success)
        return fail(
          res,
          400,
          "Supply a valid email, a limit from 1 to 50, and a valid cursor.",
        );
      let cursor;
      if (input.data.cursor) {
        try {
          if (
            input.data.cursor.length > 2048 ||
            !/^[A-Za-z0-9_-]+$/.test(input.data.cursor)
          )
            throw new Error();
          cursor = cursorSchema.parse(
            JSON.parse(
              Buffer.from(input.data.cursor, "base64url").toString("utf8"),
            ),
          );
          if (cursor.email !== input.data.email) throw new Error();
        } catch {
          return fail(res, 400, "Invalid cursor for this email.");
        }
      }
      res.json(await store.list({ ...input.data, cursor }));
    });
    app.get(`${prefix}/bookings/:id`, async (req, res) => {
      if (!z.uuid().safeParse(req.params.id).success)
        return fail(res, 404, "Booking not found.");
      const booking = await store.find(req.params.id);
      if (!booking) return fail(res, 404, "Booking not found.");
      res.json(booking);
    });
    app.delete(`${prefix}/bookings/:id`, async (req, res) => {
      if (!z.uuid().safeParse(req.params.id).success)
        return fail(res, 404, "Booking not found.");
      const result = await store.cancel(req.params.id);
      res.status(result.status).json(result.body);
    });
  }
  app.use("/api", (_req, res) => fail(res, 404, "Endpoint not found."));
  if (production) {
    const directory = fileURLToPath(
      new URL("../../web/dist/", import.meta.url),
    );
    app.use(express.static(directory));
    app.get("/{*path}", (_req, res) => res.sendFile(`${directory}/index.html`));
  }
  app.use((_req, res) => fail(res, 404, "Endpoint not found."));
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed")
      return fail(res, 400, "Invalid JSON.");
    if (err.type === "entity.too.large")
      return fail(res, 413, "Request is too large.");
    console.error("Request failed:", err.code ?? err.name);
    return fail(
      res,
      503,
      "The service is unavailable. Please try again later.",
    );
  });
  return app;
}
