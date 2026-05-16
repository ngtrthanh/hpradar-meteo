# AGENTS.md — operational rules for this repo

This file is for AI agents and humans operating on a deployed instance of
`hpradar-meteo`. Read it before making changes.

## Source of truth

```
/srv/lab/tide/                        ← source repo (git, push to GH)
└── app/...                           ← THIS is the source of truth
ops-hydro-api (Docker container)      ← runtime, built from the image, ephemeral
```

The container is built from `ghcr.io/ngtrthanh/hpradar-meteo:latest`, which
is rebuilt from this repo. **Anything you change inside the container is
discarded the next time the image is pulled or the container is recreated.**

## Golden rules

1. **Always edit the source repo first.**
   Do not `docker exec ... vi /app/...`, do not `sed` files inside the
   container, and do not run `pip install` inside the container as a fix.
   If a fix only exists inside the container, it is one watchtower pull
   away from being lost.

2. **Sync the source to the container only after editing the source.**
   The supported pattern for hot-applying a fix without waiting for an
   image rebuild is:
   ```bash
   # edit /srv/lab/tide/app/<file>
   docker cp /srv/lab/tide/app/<file> ops-hydro-api:/app/<file>
   docker restart ops-hydro-api    # only if Python files changed
   ```
   Static assets (JS/CSS/HTML under `app/static/`) take effect on the next
   page load — no restart needed, but bump the `?v=N` cache-buster in
   `index.html` so browsers fetch the new file.

3. **Commit before deploying.**
   The "edit container, forget to commit, next deploy reverts the fix"
   loop is exactly how the Vietnam-MMSI marker bug came back twice.
   Order of operations:
   ```
   edit source → commit → docker cp to container → verify
   ```
   Not:
   ```
   docker exec edit → forget → next pull wipes the fix
   ```

4. **Static asset cache-busting is mandatory after frontend edits.**
   Cloudflare and browsers cache `app.css` and `app.js` aggressively.
   Bump the `?v=N` query parameter in `index.html` whenever you change
   either file.

5. **Database schema changes need the `scale_user` role.**
   The `ais_user` runtime user owns nothing in `mhdb`; it can `INSERT` /
   `SELECT` / `UPDATE` data but cannot `ALTER` or `DROP`. For schema
   changes connect as `scale_user` (see ops vault).

## Shared-database awareness

`mhdb` is shared. Other services / older deployments on other hosts may
also write to `stations`, `meteo_obs`, `hydro_obs`. If you see records
appearing that the current code path cannot produce:

1. Check `pg_stat_activity` for `client_addr` values that don't match this
   container's network.
2. Walk the Tailscale / Cloudflare tunnel routes for any other host
   serving an `/api/...` for hydro data — `meteo.hpradar.com`,
   `tide.hpradar.com`, etc.
3. Stop the rogue writer at its source. Do not work around it in the
   reader.

## Frontend marker rendering

`syncMK()` iterates `STN`. If any single station throws inside the
`forEach` callback (e.g. MapLibre rejects `setLngLat([NaN, NaN])`), the
entire loop aborts and **every station after it is silently dropped**.

Always:
- Validate `lat` / `lon` are finite numbers in valid ranges before passing
  to MapLibre.
- Wrap `setLngLat()` and `new maplibregl.Marker(...).addTo(map)` in
  `try/catch`.

## Deploy / verify checklist

- [ ] All edits are in `/srv/lab/tide/`, not just the container.
- [ ] `git status` shows only intended files.
- [ ] `git diff` reviewed.
- [ ] `python3 -m py_compile app/*.py app/routes/*.py` passes.
- [ ] CHANGELOG updated.
- [ ] `?v=N` bumped if `app.js` or `app.css` changed.
- [ ] `docker cp` fresh files into `ops-hydro-api`.
- [ ] `docker restart ops-hydro-api` if Python changed.
- [ ] `docker logs ops-hydro-api --tail 50` shows clean startup, no
      `must be owner of`, no `record "new" has no field "..."`.
- [ ] `curl` smoke test on `/api/health`, `/api/counts`, `/api/stations`.
- [ ] Headless-browser sanity check confirms `MK.size` ≈ `STN.length`.
- [ ] Commit + tag + push.
