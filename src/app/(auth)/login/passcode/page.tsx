import { redirect } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { PasscodeUnlock } from '@/features/auth/components/PasscodeUnlock';
import { readLoginFlow } from '@/lib/auth/login-flow';
import { getPrivateCode } from '@/lib/auth/cookies';
import { getSession } from '@/lib/auth/session';

// XD px -> scaling rem.
const rem = (px: number) => `${px * 0.0625}rem`;

/** "super_admin" → "SA" — display only. */
function roleAbbr(role: string) {
    return role
        .split('_')
        .map((word) => word.charAt(0).toUpperCase())
        .join('');
}

/**
 * Enter passcode — shown at BOTH moments the passcode is asked:
 *   returning-user sign-in: private code collected, no session yet. The
 *     passcode is the `secret` for POST /v1/auth/login.
 *   fresh page load: the session cookie is alive, the person re-proves themself.
 *
 * The name/role line is empty on the pre-session path: nothing identifies the
 * admin until sign-in succeeds, and there is no endpoint that resolves a
 * private code on its own.
 *
 * NOTE: avatar is a placeholder (no image asset yet) carrying the XD background
 * blur (amount 12, opacity 60%); it shows once a real photo is dropped in.
 */
export default async function EnterPasscodePage() {
    const flow = await readLoginFlow();
    // A carried private code means we are mid-sign-in, so skip the session read.
    const session = flow.privateCode ? null : await getSession();
    const identity = flow.privateCode
        ? { name: '', role: '' }
        : session
          ? { name: session.name, role: session.role }
          : // No session, but a private code saved from a previous sign-in: this
            // is the lock screen after the access token lapsed. The passcode can
            // still unlock it, so show the screen instead of demanding the
            // private code again.
            (await getPrivateCode())
            ? { name: '', role: '' }
            : null;
    if (!identity) redirect('/login');

    return (
        <main className="flex h-full flex-col justify-center items-center">
            {/* Avatar 200×200, radius 15, with the XD background blur. */}

            <div className="h-45/100 flex items-end justify-center">
                {/* One plate only. The background and the rad-15 corners come
                    from this box; avatar.svg is a transparent glyph, so there
                    is no second background of a different colour or radius
                    showing through at the corners. Swap the glyph for the real
                    photo when one exists — the KYC reference image. */}
                <div className="bg-muted/40 h-200 w-200 overflow-hidden rad-15">
                    <Icon
                        name="side/avatar"
                        width={200}
                        height={200}
                        className="h-full w-full object-cover"
                    />
                </div>
            </div>
            <div className="h-55/100 flex flex-col items-center">
                <span
                    className="fz-18 text-ink leading-none font-bold"
                    style={{ marginTop: rem(12) }}
                >
                    {roleAbbr(identity.role)}
                </span>
                <span
                    className="fz-18 text-ink leading-none font-normal"
                    style={{ marginTop: rem(6) }}
                >
                    {identity.name}
                </span>
                <span
                    className="fz-12 text-ink leading-none font-bold"
                    style={{ marginTop: rem(20) }}
                >
                    Enter Your Passcode
                </span>

                <div style={{ marginTop: rem(16) }}>
                    <PasscodeUnlock />
                </div>
            </div>
        </main>
    );
}
