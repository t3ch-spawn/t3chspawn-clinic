export type Slot = { id: string; start: string; end: string; provider: string; available: boolean };
export type Booking = { id: string; slot_id: string; name: string; email: string; status: 'confirmed' | 'cancelled'; created_at: string };
export type BookingPage = { bookings: Booking[]; next_cursor: string | null };

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function request<T>(path: string, key: string, options: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers: { 'X-API-Key': key, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({ error: 'The API returned an unexpected response.' }));
  if (!response.ok) {
    const retry = response.headers.get('Retry-After');
    throw new ApiError(`${data.error ?? 'Request failed.'}${retry ? ` Try again in ${retry} seconds.` : ''}`, response.status);
  }
  return data;
}
