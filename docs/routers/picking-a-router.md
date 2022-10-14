---
title: Picking a Router
order: 1
new: true
---

# Picking a Router

While your app will only use a single router, several routers are available depending on the environment your app is running in. This document should help you figure out which one to use.

## Using v6.4 Data APIs

In v6.4, new routers were introduced that support the new data APIs:

- [`createBrowserRouter`][createbrowserrouter]
- [`createMemoryRouter`][creatememoryrouter]
- [`createHashRouter`][createhashrouter]

The following routers do not support the data APIs:

- [`<BrowserRouter>`][browserrouter]
- [`<MemoryRouter>`][memoryrouter]
- [`<HashRouter>`][hashrouter]
- [`<NativeRouter>`][nativerouter]
- [`<StaticRouter>`][staticrouter]

We recommend updating your app to use one of the new routers from 6.4. The data APIs are currently not supported in React Native, but should be eventually.

The easiest way to quickly update to a v6.4 is to get the help from [`createRoutesFromElements`][createroutesfromelements] so you don't need to convert your `<Route>` elements to route objects.

```jsx
import {
  createBrowserRouter,
  RouterProvider,
} from "react-router-dom";

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route path="/" element={<Root />}>
      <Route path="dashboard" element={<Dashboard />} />
      {/* ... etc. */}
    </Route>
  )
);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
);
```

## Web Projects

We recommend all web projects use [`createBrowserRouter`][createbrowserrouter].

It uses the full URL instead of the hash urls (`#this/stuff`) common in web apps before `window.pushState` was standardized. Full URLs are better for SEO, better for server rendering, and are just more compatible with the rest of the web platform.

If you're hosting your app on a static file server, you'll need to configure it to send all requests to your `index.html` to avoid getting 404s.

If for some reason you can't use the full URL, [`createHashRouter`][createhashrouter] is the next best thing.

If you're not interested in the data APIs, you can continue to use [`<BrowserRouter>`][browserrouter] or, if you can't use full URLs, [`<HashRouter>`][hashrouter].

## Testing

Testing components that use React Router APIs is easiest with [`createMemoryRouter`][creatememoryrouter] or [`<MemoryRouter>`][memoryrouter] instead of the routers you use in your app that require DOM history APIs.

Some of the React Router APIs internally use `fetch`, which is only supported starting from Node.js v18. If your project uses v17 or lower, you should add a `fetch` polyfill manually. One way to do that, is to install [`whatwg-fetch`](https://www.npmjs.com/package/whatwg-fetch) and add it to your `jest.config.js` file like so:
```js
module.exports = {
  setupFiles: ['whatwg-fetch'],
  // ...rest of the config
}
```

## React Native

You will use [`<NativeRouter>`][nativerouter] from React Native projects.

The data APIs from v6.4 are currently not supported in React Native, but should be eventually.

[createbrowserrouter]: ./create-browser-router
[createhashrouter]: ./create-hash-router
[creatememoryrouter]: ./create-memory-router
[createroutesfromelements]: ../utils/create-routes-from-elements
[browserrouter]: ../router-components/browser-router
[memoryrouter]: ../router-components/memory-router
[hashrouter]: ../router-components/hash-router
[nativerouter]: ../router-components/native-router
[staticrouter]: ../router-components/static-router
