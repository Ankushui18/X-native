# Bundled font notices

The native UI embeds these font families. Their licenses accompany source and
portable packages in `apps/x-designer/assets/fonts/licenses/`:

- **Inter**, by the Inter Project Authors. SIL Open Font License 1.1.
  Upstream: https://github.com/rsms/inter — `LICENSE.txt`.
- **JetBrains Mono**, by the JetBrains Mono Project Authors. SIL Open Font License
  1.1. Upstream: https://github.com/JetBrains/JetBrainsMono — `OFL.txt`.

The web editor also bundles Latin WOFF2 subsets of **Roboto**, **Geist**, **Space Grotesk**, **Plus Jakarta Sans**, **Outfit**, **Fira Code**, **JetBrains Mono** (variable weights), and **Poppins** (100–900). They come from the corresponding `@fontsource-variable/*` / `@fontsource/poppins` 5.3.0 packages and are licensed under the SIL Open Font License 1.1; their individual notices are at `apps/web/public/fonts/licenses/`. These local fonts ensure that the inspector's advertised choices actually render when the user has not installed them.

The notices above concern fonts only. No project-code license is assigned by this
reliability patch; that is a maintainer decision. Rust dependency license terms
are recorded in the pinned crates' package metadata; review a complete dependency
notice inventory before external binary distribution.
