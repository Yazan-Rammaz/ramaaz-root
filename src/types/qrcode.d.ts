/**
 * Types for `qrcode`, which ships none.
 *
 * Hand-written and deliberately narrow: `@types/qrcode` describes the whole
 * surface — canvas, terminal, file output, the streaming API — and every one of
 * those is an import this app should never make. Declaring only `toDataURL`
 * means using anything else is a type error rather than a discovery at runtime.
 *
 * Widen it when something genuinely needs more, not pre-emptively.
 */
declare module 'qrcode' {
    export interface QRCodeToDataURLOptions {
        /** Quiet-zone width in modules. The spec says 4; 1 is usual on screen. */
        margin?: number;
        /** Output size in px. Rendered larger than displayed, for sharpness. */
        width?: number;
        /**
         * Error correction. Higher survives more damage at the cost of a denser
         * symbol — and a denser symbol is harder to scan off a monitor, which
         * is the only surface this app ever draws one on.
         */
        errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
        color?: { dark?: string; light?: string };
    }

    /** Resolves to a `data:image/png;base64,…` URL. */
    export function toDataURL(
        text: string,
        options?: QRCodeToDataURLOptions,
    ): Promise<string>;

    /**
     * The symbol's raw module grid — what `CustomQR` draws from.
     *
     * `modules.data` is row-major and one byte per module, so a module at
     * (row, col) is `data[row * modules.size + col]`, and `1` means dark.
     */
    export interface QRCode {
        modules: { size: number; data: Uint8Array | number[] };
    }

    export function create(
        text: string,
        options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' },
    ): QRCode;

    const _default: { toDataURL: typeof toDataURL; create: typeof create };
    export default _default;
}
