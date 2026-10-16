# Project context

This is the independent ChatGPT continuation of `redtil/audiobookapp`, rooted at upstream commit `37fc945f9a93e2ce026bcbcb46b8dbc4bf1a83ff`.

- App: `redtil/audiobookapp_chatgpt`; private library: `redtil/audiobook-data_chatgpt`.
- Keep repository defaults and browser storage isolated from the original app. Central configuration is in `src/config.js`.
- Vite frontend: `src/` and `index.html`. GitHub Actions backend: `server/` and `.github/workflows/prepare.yml`.
- Install with `npm ci`; verify with `npm run build`. On Windows use `npm.cmd` if PowerShell blocks npm scripts. Development: `npm run dev`.
- The server supports `MOCK_VOICE=1` for checks without downloading the narration model. Do not place credentials or private books in the source repository.
- Read README.md for setup and the unfinished PDF/narration requests from the reference session. Do not claim these were completed by copying the source.
