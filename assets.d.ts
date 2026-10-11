// Images are bundled as data URLs (see the esbuild loader config).
declare module '*.gif' {
    const dataUrl: string;
    export default dataUrl;
}
declare module '*.jpg' {
    const dataUrl: string;
    export default dataUrl;
}
