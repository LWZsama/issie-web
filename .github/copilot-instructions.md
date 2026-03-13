# issie-web Copilot Instructions

## Project Overview

`issie-web` is the browser-first continuation of the original Issie circuit editor and simulator.

The current repository is intentionally focused on the static web application:

- F# renderer/editor/simulator logic compiled with Fable
- browser-safe shims for former Electron/Node integrations
- webpack bundling for a static GitHub Pages deployment
- browser-native file access, session recovery, and interaction handling

Do not treat this repository as an Electron desktop app.

## Repository Shape

- `src/Renderer/`: main F# Elmish application
- `src/browser-shims/`: browser-compatible replacements for Node/Electron modules
- `scripts/build-web.js`: clean-checkout browser build pipeline
- `public/`: HTML shell and favicon
- `static/`: runtime static assets copied into the final bundle
- `.github/workflows/deploy-pages.yml`: GitHub Pages build and deploy workflow

## Build Workflow

Use the browser build pipeline only:

```bash
npm run typecheck
npm run build
```

The build must work from a clean checkout and must:

1. restore .NET tools
2. restore `src/Renderer/Renderer.fsproj`
3. run Fable for the renderer project
4. run webpack
5. emit a static site in `build/`

## Architectural Guidance

### Elmish MVU

- application state lives in the renderer model
- changes flow through message handling in the update path
- side effects should stay explicit and browser-safe

### Browser Constraints

- no Electron runtime dependencies in the shipped bundle
- no Node-only browser runtime APIs
- no desktop packaging/release assumptions
- no reliance on committed generated Fable output

### File and Storage Behavior

- prefer browser-native file APIs
- keep autosave/session recovery separate from explicit user saves
- keep project import logic quota-aware and browser-safe

## Coding Expectations

- prefer minimal, targeted fixes over broad rewrites
- preserve existing F# logic where possible
- keep changes compatible with GitHub Pages project-path hosting under `/issie-web/`
- avoid reintroducing desktop-only scripts, configs, or workflows

## Validation

Before finishing work, prefer to validate with:

```bash
npm run typecheck
npm run build
```

## Attribution

This repository is derived from the original Issie work and remains GPL-licensed, but the repo itself should be presented as the browser/web project hosted at `LWZsama/issie-web`.
