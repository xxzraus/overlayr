# Contributing to Overlayr

Thanks for taking the time to improve Overlayr! Bug reports, ideas and pull requests are all welcome.

## Reporting

- **Bug?** Open an issue with the [bug template](https://github.com/xxzraus/overlayr/issues/new?template=bug_report.yml) and include your Windows version and a screenshot if possible.
- **Idea?** Use the [feature template](https://github.com/xxzraus/overlayr/issues/new?template=feature_request.yml) and describe the task, not only the solution — it helps to pick the right implementation.
- **Question or your setup?** Start a [discussion](https://github.com/xxzraus/overlayr/discussions).

## Pull requests

1. Fork the repository and create a branch: `git checkout -b feature/my-idea`.
2. Install dependencies and build the native helpers:
   ```powershell
   npm install
   npm run build:tools
   ```
3. Keep the existing style: two spaces, single quotes, no semicolon-free experiments, comments in the language of the surrounding file.
4. Test the app manually (`npm start`) — the windows, the overlay, the tray and the wallpaper flows.
5. Describe what you changed and why in the pull request. Screenshots help a lot.

## Project conventions

- Renderer code lives in `src/ui`, main-process code in `src/main`, shared palettes and helpers in `src/shared`.
- New user-facing strings must be added to **both** languages in `src/ui/i18n.js`.
- New settings go to `src/main/store.js` defaults and, if they affect rendering, to the boot payload.
- The app must keep working without network access: catalogue and lyrics lookups fail gracefully.

## License

By contributing you agree that your changes are released under the MIT license.
