# t3chspawn Clinic

Book, find, and cancel clinic appointments. The React frontend talks to an Express backend, which stores appointments in Supabase PostgreSQL.

## Run the application

Use Node.js 22.12 or newer. From the `koya` folder, run:

```powershell
cd clinic-booking
npm.cmd install
npm.cmd run dev
```

If dependencies are already installed, you only need `npm.cmd run dev` from the `clinic-booking` folder.

| Service | Address |
| --- | --- |
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:3001 |

The development command starts both servers. Supabase is already hosted in your account; you do not need to start a local database. These instructions use this project's existing database configuration.

Keep the terminal open while using the application. Press **Ctrl+C** to stop both servers.

## Make a booking

1. Open http://localhost:5173.
2. Enter your clinic API key and click **See appointments**.
3. Pick an available appointment time.
4. Enter your full name and email address.
5. Click **Confirm appointment** and wait for the green success notification.
6. Save the labelled **Booking reference** displayed in your confirmation card.

All times are displayed in Lagos time (WAT). A successful booking clears the name and email fields, and the booked time shrinks out of the available slots. Confirmations appear on the page; no confirmation emails are sent.

Each email address can have at most **2 upcoming appointments**. Both appointments have their own booking reference and cancellation button. Cancel one before booking another when the limit is reached.

## Find your appointments

- **By reference:** enter your booking reference under **Already booked?** and click **Find booking**.
- **By email:** enter your email under **Your appointments** and click **Show appointments**. Use **Load more** when further pages are available.

After refreshing the page, use either option to retrieve your appointments again.

## Cancel an appointment

Find the appointment in its confirmation card or email results, then click **Cancel appointment**. A green notification confirms cancellation.

Cancellation deletes the booking from the database and removes it from your results. Its time becomes available again, and it no longer counts towards your two-appointment limit. The deleted reference cannot be looked up again.

## Errors and booking protection

Errors appear as red messages and toast notifications. Your form details stay available when booking fails, so you can correct them and retry.

| Level | How the application meets it |
| --- | --- |
| 1: Basic booking | Lists slots, creates bookings, and looks up bookings by reference. |
| 2: Access and validation | Booking endpoints require the correct API key. Missing names, invalid emails, and missing slot details are rejected. |
| 3: Concurrency and cancellation | Database transactions and a unique index prevent double booking. Cancellation frees the slot. |
| 4: Retries and pagination | The webpage sends an idempotency key so uncertain retries cannot create another booking. Email results support cursor pagination. |
| 5: Spam protection | The 2-upcoming-appointment cap prevents one email from accumulating successful bookings. An additional limit of 5 booking attempts per email in 60 seconds restricts repeated submissions, including failures and booking/cancellation cycles. |

Both limits notify the user with a red error toast and an inline error message. Reaching the appointment cap asks the user to cancel an appointment before booking another. Exceeding the attempt limit displays **Too many booking attempts for this email. Try again in N seconds.**, using the server's retry delay.

API clients should reuse the same `Idempotency-Key` for retries of the same booking request. Both spam protections are per email; they do not prevent someone from switching email addresses.

## Check the application

Run these commands from `clinic-booking`:

```powershell
npm.cmd test
npm.cmd run test:live
npm.cmd run build
```

- `test` checks the API workflows against an embedded PostgreSQL database.
- `test:live` repeats the workflows over real Supabase connections in an isolated test schema, then removes that schema. Your clinic bookings are not used or reset.
- `build` checks TypeScript and creates the frontend production build.
