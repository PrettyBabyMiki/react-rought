---
title: ScrollRestoration
new: true
---

# `<ScrollRestoration />`

This component will emulate the browser's scroll restoration on location changes after loaders have completed to ensure the scroll position is restored to the right spot, even across domains.

You should only render one of these and it's recommended you render it in the root route of your app:

```tsx [1,7]
import { ScrollRestoration } from "react-router-dom";

function RootRouteComponent() {
  return (
    <div>
      {/* ... */}
      <ScrollRestoration />
    </div>
  );
}
```

## `getKey`

Optional prop that defines the key React Router should use to restore scroll positions.

```tsx
<ScrollRestoration
  getKey={(location, matches) => {
    // default behavior
    return location.key;
  }}
/>
```

By default it uses `location.key`, emulating the browser's default behavior without client side routing. The user can navigate to the same URL multiple times in the stack and each entry gets its own scroll position to restore.

Some apps may want to override this behavior and restore position based on something else. Consider a social app that has four primary pages:

- "/home"
- "/messages"
- "/notifications"
- "/search"

If the user starts at "/home", scrolls down a bit, clicks "messages" in the navigation menu, then clicks "home" in the navigation menu (not the back button!) there will be three entries in the history stack:

```
1. /home
2. /messages
3. /home
```

By default, React Router (and the browser) will have two different scroll positions stored for `1` and `3` even though they have the same URL. That means as the user navigated from `2` → `3` the scroll position goes to the top instead of restoring to where it was in `1`.

A solid product decision here is to keep the users scroll position on the home feed no matter how they got there (back button or new link clicks). For this, you'd want to use the `location.pathname` as the key.

```tsx
<ScrollRestoration
  getKey={(location, matches) => {
    return location.pathname;
  }}
/>
```

Or you may want to only use the pathname for some paths, and use the normal behavior for everything else:

```tsx
<ScrollRestoration
  getKey={(location, matches) => {
    const paths = ["/home", "/notifications"];
    return paths.includes(location.pathname)
      ? // home and notifications restore by pathname
        location.pathname
      : // everything else by location like the browser
        location.key;
  }}
/>
```

## Preventing Scroll Reset

When navigation creates new scroll keys, the scroll position is reset to the top of the page. You can prevent the "scroll to top" behavior from your links:

```tsx
<Link preventScrollReset={true} />
```

See also: [`<Link preventScrollReset>`][preventscrollreset]

## Scroll Flashing

Without a server side rendering framework like [Remix][remix], you may experience some scroll flashing on initial page loads. This is because React Router can't restore scroll position until your JS bundles have downloaded, data has loaded, and the full page has rendered (if you're rendering a spinner, the viewport is likely not the size it was when the scroll position was saved).

Server Rendering frameworks can prevent scroll flashing because they can send a fully formed document on the initial load, so scroll can be restored when the page first renders.

[remix]: https://remix.run
[preventscrollreset]: ../components/link#preventscrollreset
