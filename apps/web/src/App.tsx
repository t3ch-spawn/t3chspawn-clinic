import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import gsap from 'gsap';
import { SplitText } from 'gsap/SplitText';
import { Toaster, toast } from 'sonner';
import { ApiError, request, type Booking, type BookingPage, type Slot } from './api';

gsap.registerPlugin(SplitText);

const date = (value: string) => new Intl.DateTimeFormat('en-NG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Africa/Lagos' }).format(new Date(value));
const time = (value: string) => new Intl.DateTimeFormat('en-NG', { hour: 'numeric', minute: '2-digit', timeZone: 'Africa/Lagos' }).format(new Date(value));

export default function App() {
  const root = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState('');
  const [connected, setConnected] = useState(false);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selected, setSelected] = useState<Slot | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const slotElements = useRef(new Map<string, HTMLDivElement>());
  const busyRef = useRef(false);
  const scrollGuard = useRef<{ anchor: HTMLElement | null; top: number; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lookupId, setLookupId] = useState('');
  const [historyEmail, setHistoryEmail] = useState('');
  const [history, setHistory] = useState<BookingPage | null>(null);
  const [historyOwner, setHistoryOwner] = useState('');
  const pending = useRef<{ body: string; key: string } | null>(null);

  function preserveScroll() {
    const guard = scrollGuard.current;
    if (!guard) return;
    if (guard.anchor?.isConnected) {
      const delta = guard.anchor.getBoundingClientRect().top - guard.top;
      if (Math.abs(delta) > .5) window.scrollBy({ top: delta, behavior: 'instant' });
    } else window.scrollTo({ left: guard.x, top: guard.y, behavior: 'instant' });
  }

  useLayoutEffect(() => {
    preserveScroll();
    if (!busy) scrollGuard.current = null;
  });

  useEffect(() => {
    if (!busy || !root.current) return;
    const observer = new ResizeObserver(preserveScroll);
    observer.observe(root.current);
    // Respect deliberate scrolling while a request is in flight.
    const release = () => { scrollGuard.current = null; };
    window.addEventListener('wheel', release, { passive: true });
    window.addEventListener('touchmove', release, { passive: true });
    const releaseOnKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) release();
    };
    window.addEventListener('keydown', releaseOnKey);
    return () => {
      observer.disconnect();
      window.removeEventListener('wheel', release);
      window.removeEventListener('touchmove', release);
      window.removeEventListener('keydown', releaseOnKey);
    };
  }, [busy]);

  useEffect(() => {
    document.body.classList.toggle('is-processing', busy);
    return () => document.body.classList.remove('is-processing');
  }, [busy]);

  useLayoutEffect(() => {
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      const select = gsap.utils.selector(root);
      gsap.from('.reveal', { y: 18, opacity: 0, duration: .65, stagger: .12, ease: 'power2.out' });
      gsap.from('.site-header', { y: -12, autoAlpha: 0, duration: .5, ease: 'power2.out' });
      gsap.from('.hero-eyebrow, .entry-heading', { y: 14, autoAlpha: 0, duration: .5, stagger: .1, ease: 'power2.out' });
      SplitText.create(select('.hero-title'), {
        type: 'words,chars',
        autoSplit: true,
        onSplit(self) {
          return gsap.from(self.chars, { y: 24, autoAlpha: 0, duration: .55, stagger: .025, delay: .12, ease: 'power3.out' });
        },
      });
      SplitText.create(select('.hero-copy'), {
        type: 'lines',
        mask: 'lines',
        autoSplit: true,
        onSplit(self) {
          return gsap.from(self.lines, { yPercent: 100, autoAlpha: 0, duration: .6, stagger: .1, delay: .3, ease: 'power2.out' });
        },
      });
    }, root);
    return () => media.revert();
  }, []);

  useLayoutEffect(() => {
    if (!connected) return;
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.timeline({ defaults: { ease: 'power2.out' } })
        .from('.appointments-heading', { y: 18, autoAlpha: 0, duration: .45, stagger: .1 })
        .from('.slot', { y: 30, autoAlpha: 0, duration: .48, stagger: .065, clearProps: 'transform,opacity,visibility' }, .16);
    }, root);
    return () => media.revert();
  }, [connected]);

  async function perform(action: () => Promise<void>) {
    if (busyRef.current) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const anchor = focused?.closest<HTMLElement>('form') ?? focused?.closest<HTMLElement>('section') ?? null;
    scrollGuard.current = { anchor, top: anchor?.getBoundingClientRect().top ?? 0, x: window.scrollX, y: window.scrollY };
    busyRef.current = true;
    setError(''); setBusy(true);
    try { await action(); }
    catch (e) {
      const message = e instanceof Error ? e.message : 'Something went wrong.';
      setError(message); toast.error(message);
    }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function shrinkSlot(id: string) {
    const element = slotElements.current.get(id);
    if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    await gsap.to(element, { scale: 0.65, opacity: 0, height: 0, duration: .4, ease: 'power2.in', overflow: 'hidden' });
  }
  async function load() {
    const data = await request<{ slots: Slot[] }>('/slots', key);
    await Promise.all(slots.filter(slot => slot.available && !data.slots.some(next => next.id === slot.id && next.available)).map(slot => shrinkSlot(slot.id)));
    setSlots(data.slots); setConnected(true);
    setSelected(current => data.slots.find(slot => slot.id === current?.id && slot.available && Date.parse(slot.start) > Date.now()) ?? null);
  }
  function book(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const formElement = event.currentTarget;
    const body = { slot_id: selected.id, name: String(form.get('name')).trim(), email: String(form.get('email')).trim().toLowerCase() };
    const serialized = JSON.stringify(body);
    if (pending.current?.body !== serialized) pending.current = { body: serialized, key: crypto.randomUUID() };
    const idempotencyKey = pending.current.key;
    void perform(async () => {
      let created: Booking;
      try { created = await request<Booking>('/bookings', key, { method: 'POST', body, idempotencyKey }); }
      catch (error) {
        // Only uncertain/network failures should reuse this submission's key.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) pending.current = null;
        if (error instanceof ApiError && error.status === 409) {
          // A different browser may have taken the slot or used the email's quota.
          try { await load(); await loadAppointments(body.email); } catch { /* Keep the original booking error. */ }
        }
        throw error;
      }
      setBookings(items => [...items.filter(item => item.id !== created.id), created]);
      formElement.reset();
      setSelected(null);
      toast.success('Appointment booked successfully.', { description: 'Your booking reference and cancellation button are above.' });
      await shrinkSlot(created.slot_id);
      setSlots(items => items.map(item => item.id === created.slot_id ? { ...item, available: false } : item));
      // A completed booking must never be replayed as the next submission.
      pending.current = null;
      setHistory(null);
      setHistoryEmail(created.email);
      try { await loadAppointments(created.email); }
      catch { toast.error('Your booking is confirmed, but we could not refresh your other appointments. Use Show appointments to retry.'); }
    });
  }
  async function loadAppointments(email: string, include?: Booking) {
    const items: Booking[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ email, limit: '50', ...(cursor ? { cursor } : {}) });
      const page: BookingPage = await request<BookingPage>(`/bookings?${query}`, key);
      items.push(...page.bookings); cursor = page.next_cursor;
    } while (cursor);
    const upcoming = items.filter(item => item.status === 'confirmed' && slots.some(slot => slot.id === item.slot_id && Date.parse(slot.start) > Date.now()));
    setBookings(include && !upcoming.some(item => item.id === include.id) ? [...upcoming, include] : upcoming);
  }
  async function cancelAppointment(item: Booking) {
    const cancelled = await request<Booking>(`/bookings/${item.id}`, key, { method: 'DELETE' });
    pending.current = null;
    setBookings(items => items.filter(booking => booking.id !== cancelled.id));
    setHistory(current => current && ({ ...current, bookings: current.bookings.filter(booking => booking.id !== cancelled.id) }));
    toast.success('Appointment cancelled.', { description: 'The appointment time is available to book again.' });
    try { await load(); }
    catch { toast.error('Your cancellation succeeded, but available times could not refresh. Please select Refresh.'); }
  }
  async function loadHistory(cursor?: string) {
    const email = cursor ? historyOwner : historyEmail.trim().toLowerCase();
    const query = new URLSearchParams({ email, limit: '5', ...(cursor ? { cursor } : {}) });
    const result = await request<BookingPage>(`/bookings?${query}`, key);
    setHistory(current => ({ bookings: cursor ? [...(current?.bookings ?? []), ...result.bookings] : result.bookings, next_cursor: result.next_cursor }));
    setHistoryOwner(email);
    if (!cursor) {
      await loadAppointments(email);
      if (!result.bookings.length) toast.info('No appointments found for this email address.');
    }
  }
  const available = slots.filter(slot => slot.available && Date.parse(slot.start) > Date.now());
  function warnIfNoAppointment() {
    if (!selected && !busy) toast.warning('Please select an appointment first.', {
      id: 'select-appointment-first',
      description: 'Choose a time from the available appointment cards before entering your name and email.',
    });
  }

  return <div ref={root} className="min-h-screen">
    <Toaster position="bottom-center" richColors closeButton />
    <header className="site-header mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-7">
      <a href="/" className="flex items-center gap-3 text-xl font-semibold"><span className="logo" aria-hidden="true" />t3chspawn<span className="font-normal text-stone-500">clinic</span></a>
      <span className="text-sm text-stone-600">Care that makes room for you.</span>
    </header>
    <main className="mx-auto max-w-6xl px-6 pb-16">
      <section className="grid gap-8 border-y border-stone-300 py-12 md:grid-cols-[1.4fr_1fr] md:py-16">
        <div><p className="hero-eyebrow eyebrow">YOUR HEALTH, YOUR TIME</p><h1 className="hero-title mt-5 text-5xl leading-[1.08] tracking-tight md:text-7xl">A little time.<br /><span className="serif italic">A better you.</span></h1></div>
        <div className="max-w-sm self-end"><p className="hero-copy text-lg leading-relaxed text-stone-600">Find a time that fits your day. Book an appointment with our clinic in a few simple steps.</p><p className="hero-copy mt-5 text-sm font-medium">All appointment times in Lagos (WAT)</p></div>
      </section>
      {!connected && <section className="reveal panel mt-8">
        <h2 className="entry-heading text-xl font-semibold">Connect to the clinic</h2>
        <p className="mt-2 text-sm text-stone-600">Assessment client: enter your API key to load appointments. It stays in this page's memory.</p>
        <form onSubmit={e => { e.preventDefault(); void perform(load); }} className="mt-5 flex flex-wrap items-end gap-3">
          <label className="grow">API key<input type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" required minLength={32} /></label>
          <button disabled={busy} className="primary">{busy ? 'Connecting…' : 'See appointments →'}</button>
        </form>
      </section>}
      {error && <div role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800">{error}</div>}
      {bookings.length > 0 && <section className="mt-8" aria-label="Your booking confirmations" aria-live="polite">
        <h2 className="text-2xl font-semibold">Your booking confirmations</h2>
        <p className="mt-2 text-sm">You can have up to 2 upcoming appointments per email address. Cancel one before booking another.</p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">{bookings.map(booking => {
          const bookingSlot = slots.find(slot => slot.id === booking.slot_id);
          return <article key={booking.id} className="panel border-emerald-700">
        <p className="eyebrow">{booking.status === 'confirmed' ? 'APPOINTMENT CONFIRMED' : 'APPOINTMENT CANCELLED'}</p>
        <h2 className="serif mt-3 text-3xl">{booking.name}, {booking.status === 'confirmed' ? "we'll see you soon." : 'your slot is available again.'}</h2>
        {bookingSlot ? <p className="mt-3">{date(bookingSlot.start)} at {time(bookingSlot.start)} · {bookingSlot.provider}</p> : <p className="mt-3">Slot: {booking.slot_id}</p>}
        <p className="mt-3 text-sm">Save your reference to look up this appointment. No confirmation email is sent.</p>
        <p className="mt-3 text-sm font-semibold">Booking reference</p>
        <p className="mt-1 break-all font-mono text-sm">{booking.id}</p>
        {booking.status === 'confirmed' && <button className="secondary mt-5" disabled={busy} onClick={() => void perform(() => cancelAppointment(booking))}>Cancel appointment</button>}
        </article>;
        })}</div>
      </section>}
      {connected && <>
        <div className="mt-10 grid gap-7 lg:grid-cols-[1.3fr_1fr]">
          <section>
            <div className="flex items-center justify-between"><h2 className="appointments-heading text-2xl font-semibold">01 / Pick your time</h2><button className="text-sm underline" disabled={busy} onClick={() => void perform(load)}>Refresh</button></div>
            <p className="mt-2 text-stone-600">Available appointments for the coming days.</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">{available.map(slot => <div key={slot.id} ref={element => { if (element) slotElements.current.set(slot.id, element); else slotElements.current.delete(slot.id); }}><button disabled={busy} aria-pressed={selected?.id === slot.id} onClick={() => setSelected(slot)} className={`slot w-full text-left ${selected?.id === slot.id ? 'chosen' : ''}`}>
              <span className="text-sm">{date(slot.start)}</span><strong className="mt-2 block text-2xl">{time(slot.start)}</strong><span className="mt-1 block text-xs">Until {time(slot.end)}</span><span className="mt-3 block text-sm">{slot.provider}</span>
            </button></div>)}</div>
            {!available.length && <p className="panel mt-5">No appointments are available right now. Please check again later.</p>}
          </section>
          <section className="panel h-fit lg:sticky lg:top-6">
            <h2 className="appointments-heading text-2xl font-semibold">02 / Your details</h2>
            <p className="mt-2 text-sm font-medium">Maximum 2 upcoming appointments per email address.</p>
            <p id="slot-selection-hint" className="mt-2 text-sm text-stone-600">{selected ? `${date(selected.start)} · ${time(selected.start)}` : 'Choose an appointment time to continue.'}</p>
            <form onSubmit={book} className="mt-6 grid gap-5" aria-busy={busy}>
              <label>Full name<input name="name" autoComplete="name" required readOnly={!selected} disabled={busy} onFocus={warnIfNoAppointment} onClick={warnIfNoAppointment} aria-describedby="slot-selection-hint" placeholder="Your full name" /></label>
              <label>Email address<input name="email" type="email" autoComplete="email" required readOnly={!selected} disabled={busy} onFocus={warnIfNoAppointment} onClick={warnIfNoAppointment} aria-describedby="slot-selection-hint" placeholder="you@example.com" /></label>
              <p className="text-xs leading-relaxed text-stone-500">Please leave medical details out of this form. You can discuss them with your clinician.</p>
              <button disabled={!selected || busy} className="primary">{busy ? 'Please wait…' : 'Confirm appointment →'}</button>
            </form>
          </section>
        </div>
        <section className="panel mt-10">
          <h2 className="appointments-heading text-xl font-semibold">Already booked?</h2>
          <form className="mt-5 flex flex-wrap items-end gap-4" onSubmit={e => {
            e.preventDefault();
            void perform(async () => {
              const found = await request<Booking>(`/bookings/${encodeURIComponent(lookupId.trim())}`, key);
              await loadAppointments(found.email, found);
              toast.success('Booking found.', { description: 'See your booking details and cancellation action above.' });
            });
          }}>
            <label className="grow">Booking reference<input required value={lookupId} onChange={e => setLookupId(e.target.value)} /></label>
            <button className="secondary" disabled={busy}>Find booking</button>
          </form>
        </section>
        <section className="panel mt-6">
          <h2 className="appointments-heading text-xl font-semibold">Your appointments</h2>
          <form className="mt-5 flex flex-wrap items-end gap-4" onSubmit={e => { e.preventDefault(); void perform(() => loadHistory()); }}>
            <label className="grow">Email address<input required type="email" value={historyEmail} onChange={e => setHistoryEmail(e.target.value)} /></label>
            <button className="secondary" disabled={busy}>Show appointments</button>
          </form>
          {history && <div className="mt-5" aria-live="polite">
            {!history.bookings.length && <p>No appointments found for this email.</p>}
            {history.bookings.map(item => <div key={item.id} className="border-b border-stone-200 py-4">
              <p className="font-medium">{slots.find(slot => slot.id === item.slot_id)?.provider ?? item.slot_id}<span className="ml-3 text-sm">{item.status}</span></p>
              {slots.find(slot => slot.id === item.slot_id) && <p className="mt-1 text-sm">{date(slots.find(slot => slot.id === item.slot_id)!.start)} at {time(slots.find(slot => slot.id === item.slot_id)!.start)}</p>}
              <p className="mt-2 text-xs font-semibold">Booking reference</p><p className="mt-1 break-all font-mono text-xs">{item.id}</p>
              {item.status === 'confirmed' && <button className="secondary mt-3" disabled={busy} onClick={() => void perform(() => cancelAppointment(item))}>Cancel appointment</button>}
            </div>)}
            {history.next_cursor && <button className="secondary mt-5" disabled={busy} onClick={() => void perform(() => loadHistory(history.next_cursor!))}>Load more</button>}
          </div>}
        </section>
      </>}
    </main>
    <footer className="mx-auto max-w-6xl border-t border-stone-300 px-6 py-6 text-sm text-stone-500">t3chspawn Clinic · Appointment booking</footer>
  </div>;
}
