'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
    CANVASES,
    DESIGN_CATALOG,
    DESIGN_GROUPS,
    DEVICES,
    pxPerXd,
    type CanvasKey,
} from './catalog';
import { DeviceChrome } from './DeviceChrome';

/**
 * The gallery chrome: pick a screen, pick a canvas, look at it.
 *
 * ── Why the screen is framed rather than rendered inline ────────────────────
 * The scaling engine is driven by `100vw`. A screen rendered next to a sidebar
 * reads the WINDOW's width, not its own, so it would be measured at whatever
 * the browser happened to be — which is exactly the number nobody can check
 * against XD. In its own frame it gets a viewport of precisely 1366 / 834 / 430,
 * `clamp()` resolves the root font-size to 16px, `--spacing` lands on 1px, and
 * one XD pixel becomes one rendered pixel. The readout below says so when it is
 * true, because it stops being true the moment you type a custom width.
 *
 * Zoom scales the PICTURE and not the layout: the frame keeps its true pixel
 * width and a CSS transform shrinks what you see, so a 1366 canvas fits a
 * smaller window without any of its measurements changing.
 */

type Zoom = 'fit' | number;

/** Colours for the chrome. Deliberately not the product palette — this is a tool. */
const CHROME = {
    bg: '#f4f5f7',
    panel: '#ffffff',
    line: '#e2e5ea',
    ink: '#1d1d1d',
    dim: '#767c85',
    accent: '#3066cc',
};

/**
 * Draws a highlight over whatever the pointer is on inside the frame, labelled
 * with its size in XD PIXELS — the number that has to match the design, as
 * opposed to the rendered pixels devtools would report at a non-reference width.
 *
 * ── Click to select, Alt to measure against the selection ───────────────────
 * The same gesture XD and Figma use, because it answers the question this whole
 * gallery exists for: not "how big is this" but "how far is this from that".
 * A frame full of correct sizes at wrong gaps still fails review, and a size
 * readout alone cannot tell you which gap is wrong.
 *
 * Selecting does NOT freeze the hover — you pick the anchor once and then move
 * freely, measuring against it as many times as you like.
 *
 * Same-origin, so the frame's document is reachable directly; no message
 * plumbing and nothing injected into the app's own code.
 */
function attachInspector(doc: Document, win: Window): () => void {
    const BLUE = '#3066cc';
    const RED = '#e5484d';

    const box = (color: string, fill: string) => {
        const el = doc.createElement('div');
        el.style.cssText =
            `position:fixed;pointer-events:none;z-index:2147483646;` +
            `border:1px solid ${color};background:${fill};display:none`;
        doc.body.appendChild(el);
        return el;
    };

    const tag = (bg: string) => {
        const el = doc.createElement('div');
        el.style.cssText =
            `position:fixed;pointer-events:none;z-index:2147483647;background:${bg};` +
            `color:#fff;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;` +
            `padding:2px 5px;border-radius:4px;white-space:nowrap;display:none`;
        doc.body.appendChild(el);
        return el;
    };

    const hoverBox = box(BLUE, 'rgba(48,102,204,0.12)');
    const pinBox = box(RED, 'rgba(229,72,77,0.10)');
    const hoverTag = tag('#1d1d1d');
    const pinTag = tag(RED);

    /** Distance lines and their numbers, rebuilt on every paint. */
    const rulers = doc.createElement('div');
    rulers.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    doc.body.appendChild(rulers);

    let pinnedEl: Element | null = null;
    let hoverEl: Element | null = null;
    let alt = false;

    /** Rendered px -> XD px. 1:1 at a reference width, correct at any other. */
    const factor = () => 16 / parseFloat(win.getComputedStyle(doc.documentElement).fontSize);
    const round = (n: number) => Math.round(n * 10) / 10;

    const describe = (el: Element, k: number) => {
        const r = el.getBoundingClientRect();
        const cls = (el.getAttribute('class') ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 3)
            .join(' ');
        return (
            `${el.tagName.toLowerCase()}${cls ? ` .${cls}` : ''}  ` +
            `${round(r.width * k)} × ${round(r.height * k)}  ` +
            `fz ${round(parseFloat(win.getComputedStyle(el).fontSize) * k)}`
        );
    };

    const place = (el: HTMLElement, r: DOMRect) => {
        el.style.display = 'block';
        el.style.left = `${r.left}px`;
        el.style.top = `${r.top}px`;
        el.style.width = `${r.width}px`;
        el.style.height = `${r.height}px`;
    };

    /** Puts a label just outside a box, flipping below when it would clip. */
    const placeTag = (el: HTMLElement, text: string, r: DOMRect) => {
        el.textContent = text;
        el.style.display = 'block';
        const t = el.getBoundingClientRect();
        el.style.left = `${Math.max(2, Math.min(r.left, win.innerWidth - t.width - 2))}px`;
        el.style.top = r.top > t.height + 4 ? `${r.top - t.height - 4}px` : `${r.bottom + 4}px`;
    };

    const line = (x: number, y: number, w: number, h: number) => {
        const el = doc.createElement('div');
        el.style.cssText =
            `position:absolute;background:${RED};left:${x}px;top:${y}px;` +
            `width:${Math.max(w, 1)}px;height:${Math.max(h, 1)}px`;
        rulers.appendChild(el);
    };

    const number = (value: number, cx: number, cy: number) => {
        const el = doc.createElement('div');
        el.style.cssText =
            `position:absolute;background:${RED};color:#fff;` +
            `font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;` +
            `padding:1px 4px;border-radius:3px;white-space:nowrap;transform:translate(-50%,-50%)`;
        el.textContent = String(value);
        el.style.left = `${cx}px`;
        el.style.top = `${cy}px`;
        rulers.appendChild(el);
    };

    /**
     * The gaps between the selected box and the hovered one, XD's way.
     *
     * Nested boxes get four inset numbers (which is how you check padding);
     * separated boxes get the gap on whichever axes actually have one. A pair
     * that overlaps on an axis has no gap there, and drawing a zero would be
     * noise, so that axis is simply left out.
     */
    const drawGaps = (a: DOMRect, b: DOMRect, k: number) => {
        rulers.replaceChildren();
        const xd = (n: number) => round(n * k);

        const contains = (o: DOMRect, i: DOMRect) =>
            o.left <= i.left && o.right >= i.right && o.top <= i.top && o.bottom >= i.bottom;

        if (contains(a, b) || contains(b, a)) {
            const [outer, inner] = contains(a, b) ? [a, b] : [b, a];
            const cx = inner.left + inner.width / 2;
            const cy = inner.top + inner.height / 2;

            line(cx, outer.top, 1, inner.top - outer.top);
            number(xd(inner.top - outer.top), cx, (outer.top + inner.top) / 2);

            line(cx, inner.bottom, 1, outer.bottom - inner.bottom);
            number(xd(outer.bottom - inner.bottom), cx, (inner.bottom + outer.bottom) / 2);

            line(outer.left, cy, inner.left - outer.left, 1);
            number(xd(inner.left - outer.left), (outer.left + inner.left) / 2, cy);

            line(inner.right, cy, outer.right - inner.right, 1);
            number(xd(outer.right - inner.right), (inner.right + outer.right) / 2, cy);
            return;
        }

        // Vertical gap — drawn through the middle of whatever the two share
        // horizontally, so the line sits between them rather than off to a side.
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const cx =
            overlapX > 0
                ? (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2
                : (a.left + a.width / 2 + b.left + b.width / 2) / 2;

        if (b.top >= a.bottom) {
            line(cx, a.bottom, 1, b.top - a.bottom);
            number(xd(b.top - a.bottom), cx, (a.bottom + b.top) / 2);
        } else if (a.top >= b.bottom) {
            line(cx, b.bottom, 1, a.top - b.bottom);
            number(xd(a.top - b.bottom), cx, (b.bottom + a.top) / 2);
        }

        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const cy =
            overlapY > 0
                ? (Math.max(a.top, b.top) + Math.min(a.bottom, b.bottom)) / 2
                : (a.top + a.height / 2 + b.top + b.height / 2) / 2;

        if (b.left >= a.right) {
            line(a.right, cy, b.left - a.right, 1);
            number(xd(b.left - a.right), (a.right + b.left) / 2, cy);
        } else if (a.left >= b.right) {
            line(b.right, cy, a.left - b.right, 1);
            number(xd(a.left - b.right), (b.right + a.left) / 2, cy);
        }
    };

    const paint = () => {
        const k = factor();
        rulers.replaceChildren();

        if (pinnedEl) {
            const pr = pinnedEl.getBoundingClientRect();
            place(pinBox, pr);
            placeTag(pinTag, describe(pinnedEl, k), pr);
        } else {
            pinBox.style.display = 'none';
            pinTag.style.display = 'none';
        }

        if (!hoverEl) {
            hoverBox.style.display = 'none';
            hoverTag.style.display = 'none';
            return;
        }

        const hr = hoverEl.getBoundingClientRect();
        place(hoverBox, hr);

        if (alt && pinnedEl && pinnedEl !== hoverEl) {
            drawGaps(pinnedEl.getBoundingClientRect(), hr, k);
            // The size readout would sit on top of the numbers that matter now.
            hoverTag.style.display = 'none';
        } else {
            placeTag(hoverTag, describe(hoverEl, k), hr);
        }
    };

    const onMove = (e: MouseEvent) => {
        alt = e.altKey;
        // Every overlay is pointer-events:none, so none of them is ever the hit.
        const el = doc.elementFromPoint(e.clientX, e.clientY);
        if (!el) return;
        hoverEl = el;
        paint();
    };

    const onLeave = () => {
        hoverEl = null;
        paint();
    };

    // Select the anchor to measure from. The click is swallowed so inspecting a
    // button does not also press it.
    const onClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        pinnedEl = pinnedEl === hoverEl ? null : hoverEl;
        paint();
    };

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            pinnedEl = null;
            paint();
            return;
        }
        if (e.key === 'Alt') {
            // Windows otherwise hands Alt to the browser's menu bar and the
            // keyup never arrives, leaving the gaps stuck on.
            e.preventDefault();
            alt = true;
            paint();
        }
    };

    const onKeyUp = (e: KeyboardEvent) => {
        if (e.key !== 'Alt') return;
        alt = false;
        paint();
    };

    const reposition = () => paint();

    doc.addEventListener('mousemove', onMove, true);
    doc.addEventListener('mouseleave', onLeave, true);
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('keyup', onKeyUp, true);
    win.addEventListener('scroll', reposition, true);
    win.addEventListener('resize', reposition);

    // Keys go to whichever document holds focus, and pointing at the frame does
    // not give it any — so Alt pressed while the gallery is focused would never
    // reach the listeners above. Same origin, so the parent can simply be
    // listened to as well. (`mousemove` carries `altKey` too, which covers the
    // common case of pressing Alt while already moving.)
    const parent = win.parent && win.parent !== win ? win.parent : null;
    parent?.addEventListener('keydown', onKeyDown, true);
    parent?.addEventListener('keyup', onKeyUp, true);

    return () => {
        doc.removeEventListener('mousemove', onMove, true);
        doc.removeEventListener('mouseleave', onLeave, true);
        doc.removeEventListener('click', onClick, true);
        doc.removeEventListener('keydown', onKeyDown, true);
        doc.removeEventListener('keyup', onKeyUp, true);
        win.removeEventListener('scroll', reposition, true);
        win.removeEventListener('resize', reposition);
        parent?.removeEventListener('keydown', onKeyDown, true);
        parent?.removeEventListener('keyup', onKeyUp, true);
        [hoverBox, pinBox, hoverTag, pinTag, rulers].forEach((el) => el.remove());
    };
}

export function DesignGallery() {
    const [slug, setSlug] = useState(DESIGN_CATALOG[0].slug);
    const entry = DESIGN_CATALOG.find((e) => e.slug === slug) ?? DESIGN_CATALOG[0];

    const [canvasKey, setCanvasKey] = useState<CanvasKey>(entry.canvas);
    // Just the box. Canvases carry a label and devices carry an `estimated`
    // flag; neither belongs in the frame's dimensions.
    const [size, setSize] = useState<{ width: number; height: number }>({
        width: CANVASES[entry.canvas].width,
        height: CANVASES[entry.canvas].height,
    });
    // Fit by default — a whole screen on screen beats a true-size one you have
    // to scroll. The frame still LAYS OUT at its real width either way; the
    // transform scales the picture, not the viewport, so nothing about the
    // design changes. The only cost is that boxes read off the OUTER page are
    // scaled by this factor, which is why the footer says so and why Inspect
    // (which converts) is the right way to measure while zoomed.
    const [zoom, setZoom] = useState<Zoom>('fit');
    const [inspect, setInspect] = useState(false);
    /** Bumped to force the frame to reload the same screen. */
    const [reloadKey, setReloadKey] = useState(0);
    const [fitScale, setFitScale] = useState(1);
    /** Index into DEVICES, or null for a bare frame with no phone around it. */
    const [deviceIndex, setDeviceIndex] = useState<number | null>(null);

    // Which device the frame is wearing. Held as an index rather than looked up
    // from the size, because Safari and Chrome share a content box (440 x 796)
    // and only the button pressed can say which of the two is meant.
    const device = deviceIndex === null ? undefined : DEVICES[deviceIndex];

    // The SHELL is the whole phone; the frame inside it is only the web content.
    // Fit has to measure the shell, or a browser preset would be cut off by
    // exactly the height of its own toolbars.
    const fitW = device?.width ?? size.width;
    const fitH = device ? (device.screenHeight ?? device.height) : size.height;

    const stageRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<HTMLIFrameElement>(null);

    // The splash covers every full document load, and each screen you open is
    // one — so without this the gallery flashes a loading bar before every
    // single screen. Same origin and same tab means the frame reads this very
    // marker, and no production code had to learn about the gallery.
    useEffect(() => {
        try {
            sessionStorage.setItem('root_splash_seen', '1');
        } catch {
            /* private mode — the splash will just play; not worth handling */
        }
    }, []);

    /**
     * Has the viewport been chosen by hand?
     *
     * Until it has, switching screens follows the entry's own canvas — mobile
     * screens open at 430, dashboard ones at 1366 — because re-picking the right
     * width every time is the friction that ends with a screen checked at the
     * wrong one.
     *
     * The moment you press a device, a canvas, or type a number, that stops:
     * the size is yours and it survives every screen change. Checking one
     * viewport across a whole flow is the actual job, and having the frame snap
     * back to 430 x 932 on every click made it impossible. "Auto" hands it back.
     */
    const [sizePinned, setSizePinned] = useState(false);

    const select = useCallback(
        (next: string) => {
            setSlug(next);
            if (sizePinned) return;
            const e = DESIGN_CATALOG.find((x) => x.slug === next);
            if (e) {
                setCanvasKey(e.canvas);
                setSize({ width: CANVASES[e.canvas].width, height: CANVASES[e.canvas].height });
            }
        },
        [sizePinned],
    );

    const pickCanvas = useCallback((key: CanvasKey) => {
        setCanvasKey(key);
        setSize({ width: CANVASES[key].width, height: CANVASES[key].height });
        setSizePinned(true);
    }, []);

    /** Back to following each screen's own canvas. */
    const unpinSize = useCallback(() => {
        setSizePinned(false);
        const e = DESIGN_CATALOG.find((x) => x.slug === slug);
        if (e) {
            setCanvasKey(e.canvas);
            setSize({ width: CANVASES[e.canvas].width, height: CANVASES[e.canvas].height });
        }
    }, [slug]);

    // Fit is measured, not guessed: the stage is whatever the window leaves
    // after the sidebar, and it changes when the window does.
    useLayoutEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const measure = () => {
            const pad = 48;
            const w = (stage.clientWidth - pad) / fitW;
            const h = (stage.clientHeight - pad) / fitH;
            setFitScale(Math.min(1, w, h));
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(stage);
        return () => ro.disconnect();
    }, [fitW, fitH]);

    const scale = zoom === 'fit' ? fitScale : zoom;

    // Re-attach on every frame load, because a navigation inside the frame
    // (the KYC steps navigate each other) replaces the document the listeners
    // were on.
    useEffect(() => {
        const frame = frameRef.current;
        if (!frame || !inspect) return;

        let detach: (() => void) | undefined;
        const setup = () => {
            detach?.();
            const doc = frame.contentDocument;
            const win = frame.contentWindow;
            if (doc?.body && win) detach = attachInspector(doc, win);
        };

        setup();
        frame.addEventListener('load', setup);
        return () => {
            frame.removeEventListener('load', setup);
            detach?.();
        };
    }, [inspect, slug, reloadKey]);

    const index = DESIGN_CATALOG.findIndex((e) => e.slug === slug);
    const step = (by: number) => {
        const next = DESIGN_CATALOG[(index + by + DESIGN_CATALOG.length) % DESIGN_CATALOG.length];
        select(next.slug);
    };

    // Whether the frame renders XD pixels 1:1 — derived from the scaling engine
    // rather than from "is this one of the three reference widths", because the
    // clamp caps at 16px and so every width at or above a canvas reference is
    // also 1:1. A device width of 440 qualifies; 400 does not.
    const ratio = pxPerXd(size.width);
    const exact = ratio === 1;
    const href = `/design/${slug}`;
    const host = typeof window === 'undefined' ? '' : window.location.host;

    // Built once and placed either bare or inside a phone. Keyed on the slug so
    // switching screens remounts it (and re-runs the inspector's load hook).
    const frame = (
        <iframe
            key={`${slug}-${reloadKey}`}
            ref={frameRef}
            src={href}
            title={entry.title}
            // The identity screens open a camera, and the Permissions-Policy
            // header is camera=(self) — which still requires the frame to ask
            // for it explicitly.
            allow="camera"
            style={{
                width: size.width,
                height: size.height,
                border: 'none',
                background: '#fff',
                display: 'block',
                flex: 'none',
            }}
        />
    );


    return (
        <div className="flex h-full min-h-0 w-full" style={{ background: CHROME.bg }}>
            {/* ── Screens ──────────────────────────────────────────────────── */}
            <aside
                className="thin-scroll flex w-260 shrink-0 flex-col overflow-auto"
                style={{ background: CHROME.panel, borderInlineEnd: `1px solid ${CHROME.line}` }}
            >
                <div className="px-16 pt-20 pb-12">
                    <h1 className="fz-15 font-bold" style={{ color: CHROME.ink }}>
                        Design gallery
                    </h1>
                    <p className="fz-11 mt-2" style={{ color: CHROME.dim }}>
                        Development only — 404s in production
                    </p>
                </div>

                {DESIGN_GROUPS.map((group) => (
                    <div key={group} className="pb-8">
                        <p
                            className="fz-10 px-16 pt-10 pb-6 font-bold tracking-wide uppercase"
                            style={{ color: CHROME.dim }}
                        >
                            {group}
                        </p>
                        {DESIGN_CATALOG.filter((e) => e.group === group).map((e) => {
                            const on = e.slug === slug;
                            return (
                                <button
                                    key={e.slug}
                                    type="button"
                                    onClick={() => select(e.slug)}
                                    className="block w-full px-16 py-7 text-start"
                                    style={{
                                        background: on ? '#eef3fd' : 'transparent',
                                        boxShadow: on
                                            ? `inset 3px 0 0 ${CHROME.accent}`
                                            : undefined,
                                    }}
                                >
                                    <span
                                        className="fz-13 block font-medium"
                                        style={{ color: on ? CHROME.accent : CHROME.ink }}
                                    >
                                        {e.title}
                                    </span>
                                    {e.note && (
                                        <span
                                            className="fz-10 mt-1 block leading-snug"
                                            style={{ color: CHROME.dim }}
                                        >
                                            {e.note}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                ))}
            </aside>

            {/* ── Stage ────────────────────────────────────────────────────── */}
            <div className="flex min-w-0 flex-1 flex-col">
                <header
                    className="flex shrink-0 flex-wrap items-center gap-10 px-16 py-10"
                    style={{ background: CHROME.panel, borderBottom: `1px solid ${CHROME.line}` }}
                >
                    <div className="flex items-center gap-4">
                        <ChromeButton onClick={() => step(-1)} title="Previous screen">
                            ‹
                        </ChromeButton>
                        <ChromeButton onClick={() => step(1)} title="Next screen">
                            ›
                        </ChromeButton>
                    </div>

                    <span className="fz-13 font-semibold" style={{ color: CHROME.ink }}>
                        {entry.title}
                    </span>

                    <Divider />

                    {(Object.keys(CANVASES) as CanvasKey[]).map((k) => (
                        <ChromeButton
                            key={k}
                            active={canvasKey === k && exact}
                            onClick={() => pickCanvas(k)}
                        >
                            {CANVASES[k].label} {CANVASES[k].width}
                        </ChromeButton>
                    ))}

                    <NumberField
                        label="W"
                        value={size.width}
                        onChange={(width) => {
                            setSize((s) => ({ ...s, width }));
                            setSizePinned(true);
                        }}
                    />
                    <NumberField
                        label="H"
                        value={size.height}
                        onChange={(height) => {
                            setSize((s) => ({ ...s, height }));
                            setSizePinned(true);
                        }}
                    />
                    <ChromeButton
                        active={!sizePinned}
                        onClick={unpinSize}
                        title="Follow each screen's own canvas instead of holding this size"
                    >
                        Auto
                    </ChromeButton>

                    <Divider />

                    {(['fit', 1, 0.75, 0.5] as Zoom[]).map((z) => (
                        <ChromeButton key={String(z)} active={zoom === z} onClick={() => setZoom(z)}>
                            {z === 'fit' ? 'Fit' : `${z * 100}%`}
                        </ChromeButton>
                    ))}

                    <Divider />

                    <ChromeButton active={inspect} onClick={() => setInspect((v) => !v)}>
                        Inspect
                    </ChromeButton>
                    <ChromeButton onClick={() => setReloadKey((k) => k + 1)}>Reload</ChromeButton>
                    <a
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className="fz-11 underline"
                        style={{ color: CHROME.accent }}
                    >
                        Open alone ↗
                    </a>

                    {/* Second row: real devices, as opposed to XD canvases. */}
                    <div className="flex w-full items-center gap-6">
                        <span className="fz-10" style={{ color: CHROME.dim }}>
                            Device
                        </span>
                        {DEVICES.map((d, i) => (
                            <ChromeButton
                                key={d.label + d.width + d.height + i}
                                active={deviceIndex === i}
                                title={
                                    d.estimated
                                        ? 'Estimated — confirm on the device at /design/metrics'
                                        : undefined
                                }
                                onClick={() => {
                                    setSize({ width: d.width, height: d.height });
                                    setDeviceIndex(i);
                                    setSizePinned(true);
                                }}
                            >
                                {d.label} {d.width}×{d.height}
                                {d.estimated ? ' ?' : ''}
                            </ChromeButton>
                        ))}
                        <ChromeButton
                            active={deviceIndex === null}
                            onClick={() => setDeviceIndex(null)}
                            title="Drop the phone chrome and show the bare frame"
                        >
                            No device
                        </ChromeButton>
                        <a
                            href="/design/metrics"
                            target="_blank"
                            rel="noreferrer"
                            className="fz-10 underline"
                            style={{ color: CHROME.accent }}
                        >
                            measure a real device ↗
                        </a>
                    </div>
                </header>

                <div
                    ref={stageRef}
                    className="flex min-h-0 flex-1 items-start justify-center overflow-auto p-24"
                >
                    {/* The scale transform lives on the SHELL, not the frame, so
                        the phone and the page it holds zoom as one piece. */}
                    <div style={{ width: fitW * scale, height: fitH * scale, flex: 'none' }}>
                        <div
                            style={{
                                width: fitW,
                                height: fitH,
                                transform: `scale(${scale})`,
                                transformOrigin: '0 0',
                                boxShadow:
                                    '0 1px 3px rgba(0,0,0,.12), 0 8px 32px rgba(0,0,0,.10)',
                                borderRadius: device?.radius ? `${device.radius}px` : undefined,
                                overflow: device?.radius ? 'hidden' : undefined,
                                background: '#fff',
                            }}
                        >
                            {device ? (
                                <DeviceChrome device={device} host={host}>
                                    {frame}
                                </DeviceChrome>
                            ) : (
                                frame
                            )}
                        </div>
                    </div>
                </div>

                <footer
                    className="fz-11 flex shrink-0 items-center gap-16 px-16 py-8"
                    style={{
                        background: CHROME.panel,
                        borderTop: `1px solid ${CHROME.line}`,
                        color: CHROME.dim,
                    }}
                >
                    <span>
                        frame {size.width} × {size.height}
                    </span>
                    {device && (
                        <span>
                            {device.label.replace('↳ ', '')}
                            {device.ratio ? ` · @${device.ratio}x` : ''}
                            {device.radius ? ` · corners ${device.radius}` : ''}
                        </span>
                    )}
                    <span style={{ color: scale === 1 ? undefined : '#b4690e' }}>
                        {scale === 1
                            ? 'shown at 100%'
                            : `shown at ${Math.round(scale * 100)}% — ${Math.round(size.width * scale)} × ${Math.round(size.height * scale)} on screen`}
                    </span>
                    <span style={{ color: exact && scale === 1 ? '#1a7f37' : '#b4690e' }}>
                        {!exact
                            ? `below the canvas — 1 XD px = ${Math.round(ratio * 1000) / 1000} rendered px; use Inspect`
                            : scale === 1
                              ? '1 XD px = 1 rendered px — devtools numbers are XD numbers'
                              : 'zoomed — the frame still lays out at 1:1, but measure with Inspect, not the outer page'}
                    </span>
                    {inspect && (
                        <span>
                            hover to measure · click to select · <b>Alt</b>+hover for the gap to
                            the selection · Esc to clear
                        </span>
                    )}
                </footer>
            </div>
        </div>
    );
}

function Divider() {
    return <span className="h-16 w-1" style={{ background: CHROME.line }} />;
}

function ChromeButton({
    children,
    onClick,
    active,
    title,
}: {
    children: React.ReactNode;
    onClick: () => void;
    active?: boolean;
    title?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            title={title}
            className="fz-11 rad-5 px-8 py-4 font-medium"
            style={{
                color: active ? '#fff' : CHROME.ink,
                background: active ? CHROME.accent : '#eef0f3',
            }}
        >
            {children}
        </button>
    );
}

/**
 * A width/height box you can actually type in.
 *
 * The first version rejected any keystroke that left the field outside
 * 200–4000, which sounds like validation and behaves like a locked input:
 * clearing "932" to type "745" passes through "93", "9" and "", so the control
 * fought every edit and snapped back. The text is local state now — type
 * freely — and only a value that parses IN RANGE is pushed upward. Blur
 * restores the committed number if what is left behind is not one.
 */
function NumberField({
    label,
    value,
    onChange,
}: {
    label: string;
    value: number;
    onChange: (n: number) => void;
}) {
    const [text, setText] = useState(String(value));

    // Follow the value when something else changes it (a device or canvas
    // button), but never while the field is being edited into the same number.
    // Inside a frame callback rather than the effect body: setting state
    // synchronously there cascades a render, which this project's
    // react-hooks rule rejects (SplashGate does the same).
    useEffect(() => {
        const raf = requestAnimationFrame(() =>
            setText((t) => (Number(t) === value ? t : String(value))),
        );
        return () => cancelAnimationFrame(raf);
    }, [value]);

    const commit = (raw: string) => {
        setText(raw);
        const n = Number(raw);
        if (raw.trim() !== '' && Number.isFinite(n) && n >= 200 && n <= 4000) onChange(n);
    };

    return (
        <label className="fz-11 flex items-center gap-4" style={{ color: CHROME.dim }}>
            {label}
            <input
                type="number"
                inputMode="numeric"
                value={text}
                onChange={(e) => commit(e.target.value)}
                onBlur={() => setText(String(value))}
                className="fz-11 rad-5 w-56 px-6 py-4"
                style={{ background: '#eef0f3', color: CHROME.ink }}
            />
        </label>
    );
}
