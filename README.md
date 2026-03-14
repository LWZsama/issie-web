# issie-web

This project is a personal experiment to port the desktop application [ISSIE](https://github.com/tomcl/issie) to the browser.

It is mainly created for fun and experimentation.

**Try it in your browser:** https://lwzsama.github.io/issie-web/

## Important Notice

- This project includes **a significant amount of AI-generated code** and **has not been fully audited**.
- This project **does not guarantee stability or correctness**.
- It is **not recommended for production or daily use**.
- Always **backup your work** before opening or editing important projects.
- Do **not rely on this project for long editing sessions**.
- Save **frequently** if you use it.

For long-term use, please use the original desktop [Issie](https://github.com/tomcl/issie).

## License

This project is based on the original Issie project and therefore follows the same GPL-3.0 license.

## What This Repository Contains

- `src/Renderer/`: the F# renderer/editor/simulator that is compiled to JavaScript via Fable
- `src/browser-shims/`: browser replacements for Electron and Node APIs
- `scripts/build-web.js`: browser build pipeline
- `public/`: HTML shell and browser favicon source
- `static/`: demos, HDL assets, and other runtime static files copied into the final site

## Development

### Prerequisites

- .NET 8 SDK
- Node.js 20+

You can verify the installation with:

```bash
dotnet --version
node --version
npm --version
```

### Clone the repo

```bash
git clone https://github.com/LWZsama/issie-web.git
cd issie-web
```
### Install dependencies

```bash
npm install
```

### Build

First run type checking:

```bash
npm run typecheck
```

Then build:

```bash
npm run build
```

### Output

The build process will output a static site into `build/`.

This output does not require Electron or Node at runtime and can be deployed as a static website.

You can test the built site locally by running:

```bash
npx serve build
```

## Browser-Specific Features

The browser port keeps the existing schematic editor and simulator logic, while replacing desktop runtime behavior with browser-compatible alternatives:

- project open/save flows
- browser session restore and refresh recovery
- context menus
- keyboard and mouse interaction handling
- storage cleanup for imported browser project data
- webpack aliases for Electron and Node modules to browser shims
