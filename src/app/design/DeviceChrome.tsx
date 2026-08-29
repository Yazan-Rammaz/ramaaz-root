'use client';

import type { CSSProperties, ReactNode } from 'react';
import { DEVICES } from './catalog';

type Device = (typeof DEVICES)[number];

/**
 * The phone around the screen: status bar, Dynamic Island, and Safari's or
 * Chrome's own furniture.
 *
 * ── Why bother drawing it ───────────────────────────────────────────────────
 * A number in the toolbar ("content is 796 of 956") is easy to nod at and hard
 * to feel. Drawn, the missing 160 is a bar sitting where the design assumed
 * screen, and the question stops being "does it fit" and becomes "is the button
 * under Safari's thumb rail". The Island is the same argument at the top: an
 * opaque hole in the layout that a status-bar-shaped mental model misses.
 *
 * ── Drawn from photographs of the actual device ─────────────────────────────
 * Rebuilt twice against screenshots from an iPhone 16 Pro Max, because drawing
 * it from memory got it wrong twice over:
 *
 *   - the toolbar had the old two-row layout (address pill above a five-icon
 *     row); the phone shows the iOS 18 compact single row — back, pill, more.
 *     That alone is ~50px of difference in where the content box ends.
 *   - the bar and its controls were grey. They are WHITE, lifted off the page
 *     on a soft shadow, which is why the content appears to slide under them.
 *
 * ── Inline <svg>, deliberately ──────────────────────────────────────────────
 * AGENTS.md §5 bans inline svg and routes every icon through `<Icon>` from
 * /public/icons. That rule is about PRODUCT icons — XD exports, sized in XD
 * pixels, scaling with the canvas engine. These are none of those things: they
 * are a drawing of Apple's and Google's UI, they have no export to point at,
 * they must stay at real pixels while the canvas scales around them, and the
 * shapes (a wifi fan, a reload arc) cannot be built from divs without looking
 * like the approximations they were. They live here and nowhere else.
 *
 * ⚠️ Still a likeness, not a replica. Bar heights come from `DEVICES` and the
 * ones marked `estimated` there are guesses. Never measure a browser's chrome
 * off this — measure the CONTENT box, which is exact because the iframe is
 * sized to it.
 *
 * One thing the phone cannot show you and this can: iOS screenshots omit the
 * Dynamic Island entirely (it is a hardware cutout, not pixels), so the device
 * photos have no pill at all. Here it is drawn.
 */

const INK = '#1D1D1F';
const MUTED = '#6E6E73';
const WHITE = '#FFFFFF';
const CHROME_FIELD = '#F1F3F4';

/** The lift under Safari's floating controls, and under the bar itself. */
const CONTROL_SHADOW = '0 1px 3px rgba(0,0,0,0.12), 0 0 0 0.5px rgba(0,0,0,0.04)';

// ── Glyphs ──────────────────────────────────────────────────────────────────

function CellularBars({ color = INK }: { color?: string }) {
    // Four rounded bars, each 3 wide, rising 4 -> 13, on a 2 gap.
    return (
        <svg width="18" height="13" viewBox="0 0 18 13" fill={color} aria-hidden>
            {[
                { x: 0, y: 9, h: 4 },
                { x: 5, y: 6.5, h: 6.5 },
                { x: 10, y: 3.5, h: 9.5 },
                { x: 15, y: 0, h: 13 },
            ].map((b) => (
                <rect key={b.x} x={b.x} y={b.y} width="3" height={b.h} rx="1" />
            ))}
        </svg>
    );
}

function Wifi({ color = INK }: { color?: string }) {
    // Three nested arcs over a dot — stroked, so it reads as the real fan
    // rather than the two clipped rings a div version ends up as.
    return (
        <svg width="17" height="13" viewBox="0 0 17 13" aria-hidden>
            <g fill="none" stroke={color} strokeWidth="1.9" strokeLinecap="round">
                <path d="M1 4.4a11 11 0 0 1 15 0" />
                <path d="M4 7.4a7 7 0 0 1 9 0" />
            </g>
            <circle cx="8.5" cy="11" r="1.6" fill={color} />
        </svg>
    );
}

/** Filled battery with the charge printed inside — how this device is set up. */
function Battery({ percent = 70, color = INK }: { percent?: number; color?: string }) {
    return (
        <svg width="30" height="14" viewBox="0 0 30 14" aria-hidden>
            <rect x="0" y="0" width="27" height="14" rx="4.5" fill={color} />
            <path
                d="M28.4 5.1v3.8a2.6 2.6 0 0 0 0-3.8Z"
                fill={color}
                opacity="0.4"
            />
            <text
                x="13.5"
                y="10.4"
                textAnchor="middle"
                fill={WHITE}
                style={{ font: '600 9.5px -apple-system, system-ui, sans-serif' }}
            >
                {percent}
            </text>
        </svg>
    );
}

function ChevronLeft({ color = INK }: { color?: string }) {
    return (
        <svg width="11" height="18" viewBox="0 0 11 18" fill="none" aria-hidden>
            <path
                d="M9 1 2 9l7 8"
                stroke={color}
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function ArrowLeft({ color = INK }: { color?: string }) {
    return (
        <svg width="22" height="18" viewBox="0 0 22 18" fill="none" aria-hidden>
            <path
                d="M21 9H2m0 0 7-7M2 9l7 7"
                stroke={color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

function Ellipsis({ color = INK }: { color?: string }) {
    return (
        <svg width="19" height="5" viewBox="0 0 19 5" fill={color} aria-hidden>
            <circle cx="2.4" cy="2.5" r="2.2" />
            <circle cx="9.5" cy="2.5" r="2.2" />
            <circle cx="16.6" cy="2.5" r="2.2" />
        </svg>
    );
}

/** Reload: an arc that stops short, with the arrowhead on its open end. */
function Reload({ color = INK }: { color?: string }) {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
                d="M13.6 8a5.6 5.6 0 1 1-1.9-4.2"
                stroke={color}
                strokeWidth="1.7"
                strokeLinecap="round"
            />
            <path
                d="M13.6 1.3v3.2h-3.2"
                stroke={color}
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

/** The little display-with-a-stand Safari puts before "Not Secure". */
function NotSecureGlyph({ color = MUTED }: { color?: string }) {
    return (
        <svg width="16" height="14" viewBox="0 0 16 14" fill="none" aria-hidden>
            <rect x="1" y="1" width="14" height="9.5" rx="1.8" stroke={color} strokeWidth="1.4" />
            <path
                d="M5.5 13h5M8 10.5V13"
                stroke={color}
                strokeWidth="1.4"
                strokeLinecap="round"
            />
        </svg>
    );
}

function ShareGlyph({ color = INK }: { color?: string }) {
    return (
        <svg width="15" height="19" viewBox="0 0 15 19" fill="none" aria-hidden>
            <path
                d="M4 6.5H2.5A1.5 1.5 0 0 0 1 8v9a1.5 1.5 0 0 0 1.5 1.5h10A1.5 1.5 0 0 0 14 17V8a1.5 1.5 0 0 0-1.5-1.5H11"
                stroke={color}
                strokeWidth="1.6"
                strokeLinecap="round"
            />
            <path
                d="M7.5 12V1.5m0 0L4 5m3.5-3.5L11 5"
                stroke={color}
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

/** Google Lens: a square with its edges cut away, leaving four corners. */
function LensGlyph({ color = MUTED }: { color?: string }) {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <g stroke={color} strokeWidth="1.6" strokeLinecap="round">
                <path d="M1 5V2.6A1.6 1.6 0 0 1 2.6 1H5" />
                <path d="M11 1h2.4A1.6 1.6 0 0 1 15 2.6V5" />
                <path d="M15 11v2.4a1.6 1.6 0 0 1-1.6 1.6H11" />
                <path d="M5 15H2.6A1.6 1.6 0 0 1 1 13.4V11" />
            </g>
            <circle cx="8" cy="8" r="2.4" stroke={color} strokeWidth="1.6" />
        </svg>
    );
}

// ── Bars ────────────────────────────────────────────────────────────────────

function StatusBar({ height, island }: { height: number; island?: boolean }) {
    return (
        <div
            style={{
                position: 'relative',
                height,
                flex: 'none',
                // Always the browser's own bar colour. There was a `transparent`
                // mode for painting this over a full-screen page; it went with
                // the screen presets.
                background: 'inherit',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 34px 0',
                color: INK,
                font: '600 17px/1 -apple-system, "SF Pro Text", system-ui, sans-serif',
                pointerEvents: 'none',
            }}
        >
            <span style={{ letterSpacing: 0.2 }}>9:41</span>
            {island && (
                <div
                    title="Dynamic Island — front camera and Face ID. Invisible in iOS screenshots; real on the glass."
                    style={{
                        position: 'absolute',
                        left: '50%',
                        top: 11,
                        transform: 'translateX(-50%)',
                        width: 125,
                        height: 37,
                        background: '#000',
                        borderRadius: 19,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        paddingRight: 13,
                    }}
                >
                    <div
                        style={{
                            width: 11,
                            height: 11,
                            borderRadius: '50%',
                            background: '#14141C',
                            boxShadow: 'inset 0 0 0 1px #262630',
                        }}
                    />
                </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <CellularBars />
                <Wifi />
                <Battery />
            </div>
        </div>
    );
}

function HomeIndicator() {
    return (
        <div
            style={{
                position: 'absolute',
                bottom: 9,
                left: '50%',
                transform: 'translateX(-50%)',
                width: 145,
                height: 5,
                borderRadius: 3,
                background: '#000',
            }}
        />
    );
}

/** A round white control — the shape Safari floats its back and more buttons in. */
function RoundButton({ children }: { children: ReactNode }) {
    return (
        <div
            style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                background: WHITE,
                boxShadow: CONTROL_SHADOW,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 'none',
            }}
        >
            {children}
        </div>
    );
}

/**
 * Safari's bottom bar, iOS 18 compact: one row of back, address pill, more.
 *
 * White on white, separated only by shadow — the bar is lifted off the page
 * rather than fenced off from it, and the controls are lifted again off the
 * bar. Note "Not Secure": over a LAN IP with a self-signed certificate Safari
 * says so, and it takes room from the host name. Drawn because it is what the
 * device shows.
 */
function SafariBottom({ height, host }: { height: number; host: string }) {
    return (
        <div
            style={{
                position: 'relative',
                height,
                flex: 'none',
                background: WHITE,
                // No border and no shadow along the top edge: on the device the
                // bar is the same white as the page and nothing separates them.
                // Only the CONTROLS are lifted — see CONTROL_SHADOW. An earlier
                // pass drew a divider here and it read as a fenced-off toolbar,
                // which is the opposite of what Safari does.
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '0 14px 24px',
                pointerEvents: 'none',
            }}
        >
            <RoundButton>
                <ChevronLeft />
            </RoundButton>

            <div
                style={{
                    flex: 1,
                    minWidth: 0,
                    height: 44,
                    borderRadius: 22,
                    background: WHITE,
                    boxShadow: CONTROL_SHADOW,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 7,
                    padding: '0 14px',
                    font: '400 15px/1 -apple-system, "SF Pro Text", system-ui, sans-serif',
                }}
            >
                <NotSecureGlyph />
                <span
                    style={{
                        color: INK,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 'none',
                    }}
                >
                    Not Secure —
                </span>
                <span
                    style={{
                        color: MUTED,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {host}
                </span>
                <div style={{ flex: 'none', display: 'flex' }}>
                    <Reload color={MUTED} />
                </div>
            </div>

            <RoundButton>
                <Ellipsis />
            </RoundButton>

            <HomeIndicator />
        </div>
    );
}

/** Chrome for iOS: omnibox on top — lens, URL, share. */
function ChromeOmnibox({ height, host }: { height: number; host: string }) {
    return (
        <div
            style={{
                height,
                flex: 'none',
                background: WHITE,
                padding: '0 12px',
                display: 'flex',
                alignItems: 'center',
                pointerEvents: 'none',
            }}
        >
            <div
                style={{
                    flex: 1,
                    height: 40,
                    borderRadius: 20,
                    background: CHROME_FIELD,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '0 14px',
                    font: '400 15px/1 -apple-system, system-ui, sans-serif',
                    color: INK,
                }}
            >
                <div style={{ flex: 'none', display: 'flex' }}>
                    <LensGlyph />
                </div>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden style={{ flex: 'none' }}>
                        <circle cx="6" cy="6" r="5.2" fill="none" stroke={MUTED} strokeWidth="1.4" />
                        <circle cx="6" cy="3.4" r="0.9" fill={MUTED} />
                        <rect x="5.3" y="5.2" width="1.4" height="3.8" rx="0.7" fill={MUTED} />
                    </svg>
                    <span
                        style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {host}
                    </span>
                </div>
                <div style={{ flex: 'none', display: 'flex' }}>
                    <ShareGlyph color={MUTED} />
                </div>
            </div>
        </div>
    );
}

/** Chrome's foot: back, forward, new tab, tab count, more. Ink, not tint. */
function ChromeBottom({ height }: { height: number }) {
    return (
        <div
            style={{
                position: 'relative',
                height,
                flex: 'none',
                background: WHITE,
                boxShadow: '0 -1px 12px rgba(0,0,0,0.06)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 26px 24px',
                pointerEvents: 'none',
            }}
        >
            <ArrowLeft />
            <div style={{ opacity: 0.32, transform: 'scaleX(-1)', display: 'flex' }}>
                <ArrowLeft />
            </div>
            <div
                style={{
                    width: 34,
                    height: 34,
                    borderRadius: 17,
                    background: CHROME_FIELD,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}
            >
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                    <path
                        d="M8 2v12M2 8h12"
                        stroke={INK}
                        strokeWidth="1.8"
                        strokeLinecap="round"
                    />
                </svg>
            </div>
            <div
                style={{
                    width: 21,
                    height: 21,
                    border: `2px solid ${INK}`,
                    borderRadius: 6,
                    font: '600 11px/18px -apple-system, system-ui, sans-serif',
                    textAlign: 'center',
                    color: INK,
                }}
            >
                5
            </div>
            <Ellipsis />
            <HomeIndicator />
        </div>
    );
}

/**
 * Wraps the frame in its device. `children` is the iframe, sized to the CONTENT
 * box — this never changes it, it only surrounds it.
 */
export function DeviceChrome({
    device,
    host,
    children,
    style,
}: {
    device: Device;
    /** Shown in the address bar. */
    host: string;
    children: ReactNode;
    style?: CSSProperties;
}) {
    const shellHeight = device.screenHeight ?? device.height;
    const statusBar = device.statusBar ?? 0;

    // Whatever the status bar and the content do not use belongs to the
    // browser's own bars. Derived rather than hardcoded, so correcting a content
    // height in DEVICES automatically corrects the chrome around it.
    const leftover = shellHeight - device.height - statusBar;
    const chromeTopExtra = device.browser === 'chrome' ? 56 : 0;
    const bottom = Math.max(0, leftover - chromeTopExtra);

    return (
        <div
            style={{
                width: device.width,
                height: shellHeight,
                borderRadius: device.radius,
                overflow: 'hidden',
                background: WHITE,
                display: 'flex',
                flexDirection: 'column',
                position: 'relative',
                ...style,
            }}
        >
            {/* No branch for "no browser" any more. `browser` is required on
                the type, because a preset without one offers the whole panel as
                if it were the page — a viewport no browser ever hands over, and
                the exact mistake that made this gallery disagree with a real
                phone by 148 pixels. The presets that reached that branch are
                gone, so the branch is too. */}
            <StatusBar height={statusBar} island={device.island} />
            {device.browser === 'chrome' && <ChromeOmnibox height={chromeTopExtra} host={host} />}
            {children}
            {device.browser === 'safari' ? (
                <SafariBottom height={bottom} host={host} />
            ) : (
                <ChromeBottom height={bottom} />
            )}
        </div>
    );
}
