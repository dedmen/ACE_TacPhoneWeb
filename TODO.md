# TODO

## Persist the TacPhone layout in-game

- [ ] Implement `GetLayout` and `SaveLayout` in
  `addons/tacphone/functions/fnc_processBrowserRequest.sqf`.
  - `SaveLayout` should store the `layout` value from the request so it can be
    returned later for the same player/phone.
  - `GetLayout` should return the stored layout instead of an empty hashmap.
- [ ] Keep `localStorage` as the external-browser persistence path and use the
  SQF path when `localStorage` is unavailable (the in-game browser).
- [ ] Remove the temporary placeholder comments in
  `ACE_TacPhone_Main/src/App.tsx` and avoid sending `SaveLayout` on every layout
  change once the SQF persistence is implemented.
