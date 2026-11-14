-- Preserve existing records while allowing slot IDs such as "s1".
ALTER TABLE public.bookings DROP CONSTRAINT bookings_slot_id_fkey;
ALTER TABLE public.slots ALTER COLUMN id DROP DEFAULT;
ALTER TABLE public.slots ALTER COLUMN id TYPE text USING id::text;
ALTER TABLE public.slots ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE public.bookings ALTER COLUMN slot_id TYPE text USING slot_id::text;
ALTER TABLE public.bookings ADD CONSTRAINT bookings_slot_id_fkey FOREIGN KEY (slot_id) REFERENCES public.slots(id);
ALTER TABLE public.slots DROP CONSTRAINT slots_clinician_starts_at_key;
ALTER TABLE public.bookings DROP COLUMN access_token_hash;
ALTER TABLE public.bookings DROP CONSTRAINT bookings_patient_name_check;
ALTER TABLE public.bookings ADD CHECK (char_length(patient_name) >= 1);
UPDATE public.bookings SET patient_name = trim(patient_name), patient_email = lower(trim(patient_email));
-- Match JavaScript timestamp precision for lossless cursor comparisons.
ALTER TABLE public.bookings ALTER COLUMN created_at TYPE timestamptz(3);
CREATE INDEX bookings_email_page ON public.bookings(patient_email, created_at, id);
CREATE TABLE public.booking_idempotency (
  key text PRIMARY KEY, body_hash text NOT NULL,
  status_code integer NOT NULL, response_body jsonb NOT NULL
);
CREATE TABLE public.booking_rate_limits (
  email text PRIMARY KEY, attempts timestamptz[] NOT NULL
);
ALTER TABLE public.booking_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_idempotency, public.booking_rate_limits FROM anon, authenticated;
