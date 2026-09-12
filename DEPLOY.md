# Deploying, and getting Drive to work on the deployed app

Two things have to line up: the app has to be served as a single-page app, and Google has to
recognise the exact origin it is served from.

## 1. SPA routing

`vercel.json` rewrites every unmatched path to `index.html`. Without it, `/search`, `/queue` and
`/watch/<id>` all 404 on a refresh or a shared link — they only ever worked because the router
was reached from `/` first. Vercel checks the filesystem before applying rewrites, so `/assets/*`
still serves the real files.

## 2. The Google OAuth client ID must be present at build time

Vite inlines `import.meta.env.VITE_*` into the bundle when it builds, so a client ID added to
Vercel *after* a build does not appear in that build. Set it, then deploy:

```bash
echo "<your-client-id>" | vercel env add VITE_GOOGLE_CLIENT_ID production
vercel deploy --prod -y
```

A Google OAuth **client ID is not a secret** — it ships inside the JavaScript bundle by design,
and Google's security model rests on the origin allow-list below, not on hiding it.

## 3. The deployed origin must be on the client's allow-list

In Google Cloud Console → APIs & Services → Credentials → your OAuth client → **Authorised
JavaScript origins**, add the exact origin, scheme included and no trailing slash:

```
https://<your-project>.vercel.app
```

Keep `http://localhost:5173` there too so local development keeps working.

### Why Drive testing needs a production deploy, not a preview

Google does **not** support wildcards in JavaScript origins. Every Vercel *preview* deployment
gets a fresh hostname (`<project>-<hash>-<scope>.vercel.app`), so a preview URL is an origin
Google has never seen and sign-in fails with `origin_mismatch` — and adding each one by hand is
not a workflow. The production domain is stable, so that is the one to allow-list and the one to
test Drive on.

If you want Drive working on previews as well, the way to do it is a stable alias:

```bash
vercel alias set <deployment-url> frenflix-dev.vercel.app
```

and allow-list that hostname once.

## 4. Test users

`drive.readonly` is a *restricted* scope. An unverified app works for up to 100 accounts listed
under OAuth consent screen → **Test users**, and for nobody else. Add the Google account whose
Drive you intend to read. Without this, sign-in returns `access_denied` even though the client ID
and origin are correct.

## Checklist for the first Drive test on the deployed app

1. `vercel.json` is deployed (this file's sibling).
2. `VITE_GOOGLE_CLIENT_ID` is set in Vercel for the environment being deployed.
3. The deployed origin is in Authorised JavaScript origins.
4. Your Google account is a Test user.
5. Pop-ups are allowed for the deployed origin — the sign-in flow opens one.
6. Open the deployed site → Add from Google Drive → Connect. Then pick a **small** file first:
   the whole file downloads before it plays, so a 4GB film is a poor first test.

## What will still not work, by design

- **Nothing is stored server-side.** The Drive copy lives in the browser's origin private file
  system, so it is per-browser and per-origin: files cached while testing on localhost are not
  there on the Vercel origin, and vice versa.
- **A Drive title downloads in full before playing.** Drive will not serve ranged reads to a
  browser (see the README), so first play of a large file is a wait, shown as progress.
