CREATE TABLE IF NOT EXISTS public.slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinician text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
  UNIQUE (clinician, starts_at)
);
CREATE TABLE IF NOT EXISTS public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid NOT NULL REFERENCES public.slots(id),
  patient_name text NOT NULL CHECK (char_length(patient_name) BETWEEN 2 AND 100),
  patient_email text NOT NULL,
  access_token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- PostgreSQL arbitrates simultaneous inserts, including across API instances.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_slot
  ON public.bookings(slot_id) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS slots_start ON public.slots(starts_at);
-- Browser clients must go through Express. No public Data API policies.
ALTER TABLE public.slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.slots, public.bookings FROM anon, authenticated;
