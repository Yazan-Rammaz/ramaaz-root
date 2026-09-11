import { PhoneCamera } from '@/features/kyc/handoff/PhoneCamera';

/**
 * What the QR opens on the phone.
 *
 * At the app root rather than inside `(auth)`, and for the same reason
 * `/enter/[token]` is: the group's session gate has nothing to say about a
 * caller who by definition has no session, and this screen wants no chrome
 * around a full-bleed viewfinder.
 *
 * ── No gate, deliberately ───────────────────────────────────────────────────
 * The room id in the URL is the whole capability, and it is worth very little:
 * it lets the holder offer a camera to one step of one sign-in, for two
 * minutes, once. The frames that camera produces are still judged by liveness
 * and still have to match the enrolled face. Nothing here reads a challenge,
 * writes a cookie, or reaches the auth backend.
 *
 * ⚠️ https is not optional. `getUserMedia` is a secure-context API, so this
 * page cannot open a camera over plain http on a LAN address — which is exactly
 * how a phone would reach a dev machine. `npm run dev:mobile` exists for this.
 */
export default async function HandoffPage({
    params,
    searchParams,
}: {
    params: Promise<{ token: string }>;
    searchParams: Promise<{ c?: string }>;
}) {
    const { token } = await params;
    const { c } = await searchParams;

    // Front camera for a face, back camera for a document. Anything unexpected
    // falls back to the back camera: guessing wrong there shows the user the
    // wrong view, which they will notice immediately — guessing wrong toward
    // the front camera during an ID capture is far more confusing.
    const facing = c === 'user' ? 'user' : 'environment';

    return <PhoneCamera room={token} facing={facing} />;
}
