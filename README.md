# Kokoro Reader · ChatGPT

Independent continuation of [redtil/audiobookapp](https://github.com/redtil/audiobookapp), copied from commit `37fc945f9a93e2ce026bcbcb46b8dbc4bf1a83ff` with its Git history. Reference: [the original development session](https://claude.ai/code/session_0163x1TWhGmXYskekoSwuRj4).

- App repository: `redtil/audiobookapp_chatgpt`
- Site: `https://redtil.github.io/audiobookapp_chatgpt/`
- Private library: `redtil/audiobook-data_chatgpt`
- Device settings, saved text, and audio caches use a separate ChatGPT namespace.

The new library starts empty. The original app's books, credentials, and preparation jobs are not copied.

Turn a PDF or EPUB into an audiobook with a natural-sounding voice, and listen on your phone or laptop.

1. **Add a book.** It's split into chapters and sentences and saved to your library.
2. **Prepare it.** Pick a voice (tap "Hear it" for a sample). The whole book is turned into audio **on the server**: you can close the app, and it keeps going. You can pause and continue it.
3. **Listen** on any device: play/pause, skip by sentence, seek, speed 0.8×–2×, lock-screen controls, and the sentence being read is highlighted. Where you stopped, and which books are finished, follows you between devices.

## How it works

Everything runs on GitHub, for free:

- **The app** is a static site on GitHub Pages (this repository).
- **The library** is a private repository, `audiobook-data_chatgpt`:
  - `library.json`: every book's status, position and finished state
  - `books/<id>.json`: each book's text, split into sentences
  - `audio/<id>/<part>` branches: one MP3 per chapter, plus the start time of each sentence
- **Preparing** runs the [Kokoro](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) voice model on GitHub Actions (`.github/workflows/prepare.yml`, `server/`). A book's chapters are split across up to 20 machines at once. Each machine makes audio about 2× faster than real time, so a 10-hour book takes roughly 20–30 minutes. Actions minutes are free for public repositories. The book's text and audio only ever live in the private library; the logs here show chapter numbers and timings, never titles or text.

**Background music** follows the story as it's read, and is mixed into the narration so it plays wherever the voice does:

- The server reads every sentence with an emotion model ([GoEmotions](https://huggingface.co/Cohee/distilbert-base-uncased-go-emotions-onnx), MIT), places it on the valence/arousal map music psychology uses, and marks where the mood changes: calm, reflective, melancholy, uplifting, tender, mysterious, suspense, dark or epic. A new mood has to hold for a few sentences, so the music follows scenes (`server/moods.mjs`).
- For each mood the book has, [MusicGen](https://huggingface.co/Xenova/musicgen-small) composes two 30-second pieces, made to loop seamlessly (`server/music.mjs`). MusicGen's weights are CC BY-NC 4.0: fine for personal listening, not for selling the music.
- Each chapter is then mixed (`server/mix.mjs`): the mood's music under the voice, dipping while the narrator speaks, rising in pauses and crossfading at mood changes, at five levels the listener picks from (Faint, Soft, Medium, Strong, Full; about 24 to 5 dB under the voice). Each level is its own file next to the plain narration.
- Books without server music get ambient music composed live in the browser (`src/music.js`).

The app talks to both repositories with one fine-grained access token, the "library key".

## One-time setup

1. Create a **private** repository named `audiobook-data_chatgpt` (tick "Add a README file").
2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new):
   - Repository access → Only select repositories → `audiobook-data_chatgpt` and `audiobookapp_chatgpt`
   - Permissions → **Contents**: Read and write, **Actions**: Read and write
3. In this repository: Settings → Secrets and variables → Actions → New repository secret, named `LIBRARY_KEY`, containing the token.
4. Open the site and paste the token as your library key. On other devices, use ⚙︎ → "Copy link for another device".

For publishing, set this app repository's Settings → Pages → Source to **GitHub Actions**. The included `pages.yml` workflow builds and deploys `main`; `prepare.yml` prepares books after `LIBRARY_KEY` is configured. Secrets are not transferred when copying a repository.

## Develop

    npm install
    npm run dev                      # the app, at http://localhost:5173
    MOCK_VOICE=1 node server/prepare.mjs plan   # the server side (see the comments in server/prepare.mjs)

Local development defaults to the ChatGPT repositories above. Override them under "Advanced" on the connect screen if needed. Use Node.js 22.12+ or a supported newer release.

## Pending work from the reference session

The session's final PDF parsing work was not in the copied commit. Its reported issues were spoken page numbers, running headers/footnotes, and line breaks splitting sentences in double-spaced PDFs. The proposed layout-aware parser and expressive narration controls still need implementation and validation. Existing emotion analysis controls the background music; it does not add emotion to the narrator's voice.

## Credits

- Voice: [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache 2.0) via [kokoro-js](https://github.com/hexgrad/kokoro).
- `public/words-en.txt`, used to put spaces back into words some PDFs run together: the English word-frequency list from [wordninja](https://github.com/keredson/wordninja) / [wordsninja](https://github.com/parsakafi/wordsninja) (MIT).
