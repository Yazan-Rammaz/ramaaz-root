/**
 * The camera hand-off's signaling client — two short messages, then silence.
 *
 * Talks to `/api/kyc/signal/<room>`, which our BFF proxies to the KYC Worker
 * exactly as it proxies every other KYC call (AGENTS.md §2: the browser never
 * addresses the Worker directly). The route carries no auth and needs none —
 * see the header of `routes/signal.ts` in ramaaz-kyc for why an SDP is not a
 * credential.
 *
 * Nothing here ever sees a camera frame. Once the two peers have exchanged
 * their SDPs the video flows directly between them and this file is done.
 */

export type SignalRole = 'offer' | 'answer';

function roomUrl(room: string, role: SignalRole) {
    return `/api/kyc/signal/${encodeURIComponent(room)}?role=${role}`;
}

/** Leave our SDP for the other side. */
export async function putSdp(room: string, role: SignalRole, sdp: string): Promise<void> {
    const res = await fetch(roomUrl(room, role), {
        method: 'PUT',
        body: sdp,
        headers: { 'Content-Type': 'application/sdp' },
    });
    if (!res.ok) {
        // 409 means this role was already written — a second tab, or a re-scan
        // of a QR that has been used. Worth naming, because the user-visible
        // symptom (nothing happens) is identical to a network failure.
        throw new Error(
            res.status === 409
                ? 'That code has already been used. Generate a new one.'
                : `Could not start the hand-off (${res.status})`,
        );
    }
}

/**
 * Wait for the other side's SDP.
 *
 * The room answers 204 while the other peer has not written yet, which is the
 * normal state for as long as somebody is walking to their phone — so 204 is
 * "keep waiting", never an error. 410 is the room's two-minute deadline.
 */
export async function waitForSdp(
    room: string,
    role: SignalRole,
    signal: AbortSignal,
    intervalMs = 700,
): Promise<string> {
    for (;;) {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');

        const res = await fetch(roomUrl(room, role), { signal, cache: 'no-store' });

        if (res.status === 200) return res.text();
        if (res.status === 410) throw new Error('That code expired. Generate a new one.');
        if (res.status !== 204) throw new Error(`Hand-off failed (${res.status})`);

        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

/**
 * Hold until ICE has finished gathering, then send ONE complete SDP.
 *
 * Non-trickle, deliberately. Trickle ICE would mean a candidate stream in both
 * directions and a room that stays open for the whole negotiation; waiting
 * costs a second or two and reduces the entire exchange to two messages, which
 * is what lets the relay be as small as it is.
 */
export function iceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 4000): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();

    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            pc.removeEventListener('icegatheringstatechange', check);
            clearTimeout(timer);
            resolve();
        };
        const check = () => {
            if (pc.iceGatheringState === 'complete') finish();
        };

        // A timeout rather than waiting indefinitely: gathering can stall on a
        // network that silently drops STUN, and the candidates already found
        // are usually enough on a shared LAN. Better a connection attempt with
        // what we have than a QR that never appears.
        const timer = setTimeout(finish, timeoutMs);
        pc.addEventListener('icegatheringstatechange', check);
    });
}

/**
 * ICE servers for the hand-off.
 *
 * STUN only. It lets each side discover its public address so two devices on
 * different networks can find each other; it relays nothing and sees no media.
 *
 * ⚠️ No TURN, which means a connection is NOT guaranteed. Phone and desktop on
 * the same wifi is the case this is built for and needs no STUN at all (host
 * candidates suffice). Phone on mobile data behind a symmetric NAT may fail to
 * connect, and the only fix for that is a TURN relay — which would carry the
 * video, and is a decision nobody has made.
 *
 * Note CSP does not govern this: WebRTC bypasses `connect-src`, which is a
 * known gap in CSP2/3 and the reason a separate `webrtc` directive exists as a
 * proposal. Our `connect-src 'self'` neither blocks nor permits it.
 */
export const ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
];

/** A room id: 128 bits of randomness, URL-safe, and the only capability. */
export function newRoomId(): string {
    return crypto.randomUUID().replace(/-/g, '');
}
