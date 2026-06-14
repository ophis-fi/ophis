/**
 * Browser build target shared by every Ophis browser app (cowswap-frontend +
 * explorer). Both are deployed by cloudflare-deploy.yml, so both must pin the
 * same target.
 *
 * Why pin it at all: the vite 6 -> 7 migration. Vite 7 raised its default
 * build target from the old 'modules' baseline (Chrome 87 / Safari 14) to
 * 'baseline-widely-available' (Chrome 107 / Safari 16). Without this pin, the
 * upgrade would silently drop older Safari and in-app wallet webviews that
 * traders use.
 *
 * Why safari14.1 and NOT safari14: esbuild 0.28 cannot lower destructuring for
 * the Safari 14.0 destructuring bug. Targeting a literal `safari14` makes the
 * esbuild transform throw `Transforming destructuring to the configured target
 * environment ("safari14") is not supported yet` on any file that destructures
 * (i.e. almost every file). WebKit fixed that bug in Safari 14.1, so 14.1 is
 * the lowest Safari esbuild 0.28 can build cleanly. Safari 14.0.x is a ~5-year-
 * old sub-1% sliver that carried the bug anyway, so the practical loss is nil.
 */
export const OPHIS_BUILD_TARGET: string[] = ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14.1']
