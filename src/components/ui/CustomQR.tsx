'use client';

import { JSX, useMemo } from 'react';
import QRCodeLib from 'qrcode';

/**
 * The Ramaaz QR — ported verbatim from rdb (`components/ui/CustomQR.tsx`), so
 * the code this console draws is the same one users already know from the app.
 *
 * ── Why it is drawn by hand rather than by the library ──────────────────────
 * `qrcode` renders plain black squares. This takes only the MODULE DATA from it
 * (`QRCodeLib.create`) and draws the symbol itself: data modules as slightly
 * tilted parallelograms — eight deterministic variants, picked from the row and
 * column so the same value always draws identically — and the three finder
 * patterns as rounded rings with a rounded core.
 *
 * ⚠️ Deviating from the spec's plain squares is safe only within limits, and
 * those limits are the reason for two details that look arbitrary:
 *
 *   - modules are drawn at 0.95 of their cell, so neighbours stay separable;
 *   - each finder gets a `bg` rectangle painted UNDER it before the ring, so a
 *     stray data module cannot bleed into the one pattern scanners use to
 *     locate and orient the code.
 *
 * Error correction defaults to 'L'. Raise it for longer payloads rather than
 * shrinking the module size — a denser symbol is what actually stops a phone
 * reading this off a monitor.
 */
interface CustomQRCodeProps {
    value: string;
    size?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    bg?: string;
}

// Check if a module is part of a finder pattern area (including separators)
function isFinderZone(row: number, col: number, moduleCount: number): boolean {
    // Top-left finder + separator
    if (row < 8 && col < 8) return true;
    // Top-right finder + separator
    if (row < 8 && col >= moduleCount - 8) return true;
    // Bottom-left finder + separator
    if (row >= moduleCount - 8 && col < 8) return true;
    return false;
}

export function CustomQRCode({
    value,
    size = 250,
    errorCorrectionLevel = 'L',
    bg = '#FFFFFF',
}: CustomQRCodeProps) {
    const svgElements = useMemo(() => {
        let qr;
        try {
            qr = QRCodeLib.create(value, { errorCorrectionLevel });
        } catch {
            return null;
        }

        const moduleCount = qr.modules.size;
        const data = qr.modules.data;
        const moduleSize = size / moduleCount;
        const elements: JSX.Element[] = [];

        // --- Render data modules (tilted parallelogram shapes like original SVG) ---
        for (let row = 0; row < moduleCount; row++) {
            for (let col = 0; col < moduleCount; col++) {
                if (isFinderZone(row, col, moduleCount)) continue;
                if (data[row * moduleCount + col] !== 1) continue;

                const x = col * moduleSize;
                const y = row * moduleSize;
                const s = moduleSize * 0.95;
                const cx = x + moduleSize / 2;
                const cy = y + moduleSize / 2;
                const hs = s / 2;

                // Pick a shape variant based on position (deterministic pseudo-random)
                const variant = (row * 7 + col * 13 + row * col) % 8;

                let d: string;
                switch (variant) {
                    case 0:
                        // Slight clockwise rotation
                        d = `M${cx - hs + 0.5},${cy - hs}L${cx + hs},${cy - hs - 0.3}L${cx + hs - 0.5},${cy + hs}L${cx - hs},${cy + hs + 0.3}Z`;
                        break;
                    case 1:
                        // Slight leftward skew
                        d = `M${cx - hs},${cy - hs + 0.5}L${cx + hs - 0.3},${cy - hs}L${cx + hs},${cy + hs - 0.5}L${cx - hs + 0.3},${cy + hs}Z`;
                        break;
                    case 2:
                        // Diamond-ish tilt
                        d = `M${cx - hs + 0.8},${cy - hs}L${cx + hs},${cy - hs + 0.6}L${cx + hs - 0.8},${cy + hs}L${cx - hs},${cy + hs - 0.6}Z`;
                        break;
                    case 3:
                        // Near square, subtle rotation
                        d = `M${cx - hs + 0.3},${cy - hs}L${cx + hs},${cy - hs + 0.2}L${cx + hs - 0.3},${cy + hs}L${cx - hs},${cy + hs - 0.2}Z`;
                        break;
                    case 4:
                        // Perspective skew
                        d = `M${cx - hs},${cy - hs + 0.4}L${cx + hs},${cy - hs}L${cx + hs},${cy + hs - 0.4}L${cx - hs},${cy + hs}Z`;
                        break;
                    case 5:
                        // Rotated square
                        d = `M${cx - hs + 0.6},${cy - hs}L${cx + hs},${cy - hs + 0.4}L${cx + hs - 0.6},${cy + hs}L${cx - hs},${cy + hs - 0.4}Z`;
                        break;
                    case 6:
                        // Slight counter-clockwise
                        d = `M${cx - hs},${cy - hs + 0.7}L${cx + hs - 0.5},${cy - hs}L${cx + hs},${cy + hs - 0.7}L${cx - hs + 0.5},${cy + hs}Z`;
                        break;
                    default:
                        // Near-square with small offset
                        d = `M${cx - hs + 0.4},${cy - hs + 0.1}L${cx + hs - 0.1},${cy - hs + 0.4}L${cx + hs - 0.4},${cy + hs - 0.1}L${cx - hs + 0.1},${cy + hs - 0.4}Z`;
                        break;
                }

                elements.push(<path key={`d-${row}-${col}`} d={d} fill="black" />);
            }
        }

        // --- Render finder patterns (rounded rectangles matching the original SVG) ---
        const finderSize = 7 * moduleSize;
        const outerR = finderSize * 0.33;
        const strokeW = moduleSize * 0.85;
        const coreSize = 3 * moduleSize;
        const corePad = (finderSize - coreSize) / 2;
        const coreR = coreSize * 0.25;

        const finders = [
            { x: 0, y: 0 },
            { x: (moduleCount - 7) * moduleSize, y: 0 },
            { x: 0, y: (moduleCount - 7) * moduleSize },
        ];

        finders.forEach((pos, i) => {
            // White background to clear any data modules that might overlap
            elements.push(
                <rect
                    key={`fb-${i}`}
                    x={pos.x - moduleSize * 0.5}
                    y={pos.y - moduleSize * 0.5}
                    width={finderSize + moduleSize}
                    height={finderSize + moduleSize}
                    fill={bg}
                />,
            );
            // Outer ring (stroke only)
            elements.push(
                <rect
                    key={`fo-${i}`}
                    x={pos.x + strokeW / 2}
                    y={pos.y + strokeW / 2}
                    width={finderSize - strokeW}
                    height={finderSize - strokeW}
                    rx={outerR}
                    ry={outerR}
                    fill="none"
                    stroke="black"
                    strokeWidth={strokeW}
                />,
            );
            // Inner filled core
            elements.push(
                <rect
                    key={`fc-${i}`}
                    x={pos.x + corePad}
                    y={pos.y + corePad}
                    width={coreSize}
                    height={coreSize}
                    rx={coreR}
                    ry={coreR}
                    fill="black"
                />,
            );
        });

        return elements;
        // `bg` belongs here: it paints the rectangle under each finder pattern.
        // rdb's copy omits it, so a changed background left the three finders
        // backed by the old colour — invisible on white, and a pale square in
        // each corner on anything else.
    }, [value, size, errorCorrectionLevel, bg]);

    if (!svgElements) {
        return <div style={{ width: size, height: size }} />;
    }

    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            role="img"
            aria-label={`QR Code for ${value}`}
        >
            <rect width={size} height={size} fill={bg} />
            {svgElements}
        </svg>
    );
}
