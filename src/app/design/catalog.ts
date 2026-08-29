/**
 * What the design gallery can show, as PLAIN DATA.
 *
 * Split from `screens.tsx` on purpose: the gallery chrome is a client component
 * and only needs the names and canvases, while the render map pulls in the whole
 * app — every KYC screen, the camera hooks, MediaPipe. Importing that into the
 * browser bundle to draw a list of links would ship megabytes to render text.
 */

export type CanvasKey = 'laptop' | 'tablet' | 'mobile';

/**
 * The three XD reference widths, and the heights they were drawn at.
 *
 * The WIDTH is the load-bearing number. `globals.css` sets the root font-size to
 * `clamp(floor, 100vw / (width/16), 16px)`, so at exactly the reference width it
 * resolves to 16px — and since `--spacing` is `0.0625rem`, that makes 1 XD pixel
 * equal 1 rendered pixel. Frame a screen at exactly this width and every number
 * devtools reports IS the XD number, with no conversion.
 *
 * Heights are a starting point only; the gallery lets you type another.
 */
export const CANVASES: Record<CanvasKey, { label: string; width: number; height: number }> = {
    laptop: { label: 'Laptop', width: 1366, height: 768 },
    tablet: { label: 'Tablet', width: 834, height: 1112 },
    mobile: { label: 'Mobile', width: 430, height: 932 },
};

/**
 * Real devices, as opposed to the three XD canvases.
 *
 * A canvas is the width a frame was DRAWN at; a device is the box a person
 * actually gets. They differ in a way that only ever bites on the phone: Safari
 * spends a slice of the screen on its own chrome, so a screen laid out to 932
 * opens into something meaningfully shorter, and the first thing to fall off the
 * bottom is whatever the design put there — on the intro screen, the button.
 *
 * ⚠️ The `screen` heights are exact (physical pixels ÷ the device's scale
 * factor). The `safari` heights are ESTIMATES and marked as such. Do not trust
 * them for a measurement — open /design/metrics on the device itself, read the
 * real numbers, and correct the entry here. Guessing at the one number this
 * whole preset exists to provide would be worse than not having it.
 */
export const DEVICES: {
    label: string;
    width: number;
    height: number;
    /**
     * devicePixelRatio. Layout is unaffected — CSS pixels are CSS pixels — so
     * this is here to be READ, not applied: it is what says a 25 XD icon is
     * rasterised at 75 device pixels, and therefore whether an asset exported
     * at 1x will look soft on the thing it ships to.
     */
    ratio?: number;
    /**
     * Screen corner radius in CSS px. The gallery rounds and CLIPS the frame to
     * it, so anything the design parks in a corner disappears here exactly as it
     * would on the device.
     */
    radius?: number;
    /**
     * Draw this browser's UI around the frame. When set, `width x height` is
     * the WEB CONTENT box and `screenHeight` is the whole phone, so the bars
     * occupy exactly the difference — which is the point: you see how much of
     * the screen the design does not get.
     */
    browser?: 'safari' | 'chrome';
    /** Full device height. Only meaningful alongside `browser`. */
    screenHeight?: number;
    /** iOS status bar height — the strip the Dynamic Island sits in. */
    statusBar?: number;
    /** Draw the Dynamic Island. Every device here has one; kept explicit. */
    island?: boolean;
    /** True when a number is a guess pending a reading from /design/metrics. */
    estimated?: boolean;
}[] = [
    { label: 'iPhone 16 Pro Max', width: 440, height: 956, ratio: 3, radius: 62, island: true },
    {
        label: '↳ Safari',
        width: 440,
        height: 796,
        ratio: 3,
        radius: 62,
        island: true,
        browser: 'safari',
        screenHeight: 956,
        statusBar: 62,
    },
    {
        label: '↳ Chrome',
        width: 440,
        // 766, measured on the device — 30 less than Safari's 796. Chrome's bars
        // are not Safari's, which is exactly why this could not be guessed: a
        // screen that clears Safari's fold by 20 is 10 short of clearing
        // Chrome's.
        height: 766,
        ratio: 3,
        radius: 62,
        island: true,
        browser: 'chrome',
        screenHeight: 956,
        statusBar: 62,
    },
    { label: 'iPhone 15/14 Pro Max', width: 430, height: 932, ratio: 3, radius: 55, island: true },
    {
        label: '↳ Safari',
        width: 430,
        height: 745,
        ratio: 3,
        radius: 55,
        island: true,
        browser: 'safari',
        screenHeight: 932,
        statusBar: 59,
        estimated: true,
    },
];

/** The device preset matching a viewport exactly, if there is one. */
export function deviceFor(width: number, height: number) {
    return DEVICES.find((d) => d.width === width && d.height === height);
}

/**
 * How many rendered pixels one XD pixel becomes at a given viewport width — the
 * only thing that decides whether a measurement can be read straight off the
 * screen.
 *
 * This mirrors the `clamp()` ladder in globals.css exactly, and must keep
 * mirroring it. Note what it says: 1:1 holds at or ABOVE each canvas reference,
 * not only at it, because the clamp caps the root font-size at 16px. So 440
 * (an iPhone 16 Pro Max) reads 1:1 just as 430 does, while 400 does not — the
 * mobile lock has kicked in and everything is 7% smaller than XD says.
 */
export function pxPerXd(width: number): number {
    const [divisor, floor] =
        width >= 1024 ? [85.375, 12] : width >= 600 ? [52.125, 11.5] : [26.875, 14.88];
    return Math.min(16, Math.max(floor, width / divisor)) / 16;
}

export type DesignEntry = {
    /** URL segment under /design, and the key into SCREENS. */
    slug: string;
    title: string;
    group: 'Sign-in' | 'Identity' | 'Dashboard';
    canvas: CanvasKey;
    /** Shown under the title — what to look at, or what is standing in. */
    note?: string;
};

export const DESIGN_CATALOG: DesignEntry[] = [
    // ── Sign-in ─────────────────────────────────────────────────────────────
    {
        slug: 'login',
        title: 'Private code',
        group: 'Sign-in',
        canvas: 'mobile',
        note: 'Step 1 — the code from the WhatsApp message',
    },
    {
        slug: 'device',
        title: 'Device passkey',
        group: 'Sign-in',
        canvas: 'mobile',
        note: 'WebAuthn only works on localhost or the workers.dev domain',
    },
    {
        slug: 'no-access',
        title: 'No access',
        group: 'Sign-in',
        canvas: 'mobile',
        note: 'The one refusal screen — every cause lands here',
    },
    { slug: 'forbidden', title: 'Forbidden', group: 'Sign-in', canvas: 'laptop' },

    // ── Identity (KYC) ──────────────────────────────────────────────────────
    {
        slug: 'kyc-face-scan',
        title: 'Face scan',
        group: 'Identity',
        canvas: 'mobile',
        note: 'Live camera — hold still 2s to see the capture and verdict states',
    },
    {
        slug: 'kyc-intro',
        title: 'Intro',
        group: 'Identity',
        canvas: 'mobile',
        note: 'Sample face + name',
    },
    { slug: 'kyc-id-front', title: 'ID capture — front', group: 'Identity', canvas: 'mobile' },
    { slug: 'kyc-id-back', title: 'ID capture — back', group: 'Identity', canvas: 'mobile' },
    {
        slug: 'kyc-id-summary',
        title: 'ID summary',
        group: 'Identity',
        canvas: 'mobile',
        note: 'Sample OCR fields',
    },
    {
        slug: 'kyc-face-match',
        title: 'Face match',
        group: 'Identity',
        canvas: 'mobile',
        note: 'Sample face vs sample ID',
    },
    { slug: 'kyc-success', title: 'Success', group: 'Identity', canvas: 'mobile' },
    { slug: 'kyc-contact-support', title: 'Contact support', group: 'Identity', canvas: 'mobile' },
    {
        slug: 'kyc-liveness',
        title: 'Liveness challenge',
        group: 'Identity',
        canvas: 'mobile',
        note: 'Off the current path — the screen still exists',
    },
    {
        slug: 'identity-flow',
        title: 'Whole identity flow',
        group: 'Identity',
        canvas: 'mobile',
        note: 'Walk face → intro → ID → summary → match with stubbed submits',
    },

    // ── Dashboard ───────────────────────────────────────────────────────────
    {
        slug: 'dashboard',
        title: 'Dashboard',
        group: 'Dashboard',
        canvas: 'laptop',
        note: 'Still an empty canvas',
    },
    {
        slug: 'systems',
        title: 'Systems',
        group: 'Dashboard',
        canvas: 'laptop',
        note: 'Sample rows — the real registry has no backend yet',
    },
    {
        slug: 'regions',
        title: 'Regions',
        group: 'Dashboard',
        canvas: 'laptop',
        note: 'Empty state (the mock returns no rows)',
    },
    { slug: 'currencies', title: 'Currencies', group: 'Dashboard', canvas: 'laptop' },
    { slug: 'languages', title: 'Languages', group: 'Dashboard', canvas: 'laptop' },
];

export const DESIGN_GROUPS = ['Sign-in', 'Identity', 'Dashboard'] as const;
